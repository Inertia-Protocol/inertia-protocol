// Real devnet demonstration script -- not part of the deployed protocol,
// not committed test tooling. Exercises every real instruction path
// (fast execute, rescue, self-rescue, cleanup) against the real deployed
// devnet program and prints real transaction signatures.
//
// Run with: node devnet-demo.mjs   (from inside packages/keeper)
// Requires: DEVNET_PAYER env var pointing at a funded devnet keypair JSON file.

import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, Wallet, BN, Program } = anchorPkg;
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { InertiaClient } from "@inertia-protocol/sdk";
import mockDexIdl from "./src/idl/mock_dex.json" with { type: "json" };

const RPC_URL = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
const connection = new Connection(RPC_URL, "confirmed");

function loadKeypair(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitSlots(fromSlot, n) {
  while (true) {
    const cur = await connection.getSlot("confirmed");
    if (cur - fromSlot > n) return cur;
    await sleep(500);
  }
}

const payerPath = process.env.DEVNET_PAYER;
if (!payerPath) throw new Error("Set DEVNET_PAYER to a funded devnet keypair JSON path");
const payer = loadKeypair(payerPath);

const provider = new AnchorProvider(connection, new Wallet(payer), { commitment: "confirmed" });
const inertia = new InertiaClient(provider);
const mockDex = new Program(mockDexIdl, provider);

const results = [];
function record(label, sig) {
  console.log(`${label}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  results.push({ label, sig });
}

async function fund(pubkey, lamports) {
  const sig = await connection.requestAirdrop(pubkey, lamports).catch(() => null);
  if (sig) await connection.confirmTransaction(sig, "confirmed");
  else {
    // fall back to a transfer from the funded payer if airdrop is unavailable
    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pubkey, lamports })
    );
    await provider.sendAndConfirm(tx, []);
  }
}

async function main() {
  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Inertia program:", inertia.programId.toBase58());
  console.log("Mock DEX program:", mockDex.programId.toBase58());
  console.log();

  const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    mockDex.programId
  );

  const inputMint = await createMint(connection, payer, payer.publicKey, null, 6);
  const outputMint = await createMint(connection, payer, mintAuthorityPda, null, 6);

  const userInputAta = (
    await getOrCreateAssociatedTokenAccount(connection, payer, inputMint, payer.publicKey)
  ).address;
  const userOutputAta = getAssociatedTokenAddressSync(outputMint, payer.publicKey);
  await getOrCreateAssociatedTokenAccount(connection, payer, outputMint, payer.publicKey);

  await mintTo(connection, payer, inputMint, userInputAta, payer, 10_000_000);

  const partnerWallet = Keypair.generate().publicKey;
  await fund(partnerWallet, 1_000_000); // small, just needs to exist for the demo

  function buildSwapIx(amountOut) {
    return mockDex.coder.instruction.encode("swap", {
      amountIn: new BN(1_000_000),
      amountOut: new BN(amountOut),
    });
  }
  const discriminator = Array.from(buildSwapIx(500_000).subarray(0, 8));
  const remainingAccounts = [
    { pubkey: inputMint, isSigner: false, isWritable: true },
    { pubkey: outputMint, isSigner: false, isWritable: true },
    { pubkey: mintAuthorityPda, isSigner: false, isWritable: false },
  ];

  // --- Flow 1: fast execution, before TTL ---------------------------------
  console.log("=== Flow 1: fast execution (before TTL) ===");
  {
    const { escrow, signature: initSig } = await inertia.initializeEscrow({
      userWallet: payer.publicKey,
      userInputTokenAccount: userInputAta,
      expectedDestinationTokenAccount: userOutputAta,
      gasBufferLamports: 40_000_000n,
      dynamicMinimumLamports: 40_000_000n,
      partnerWallet,
      inputAmount: 1_000_000n,
      expectedProgramId: mockDex.programId,
      expectedDiscriminator: new Uint8Array(discriminator),
      expectedOutputAmount: 500_000n,
    });
    record("initialize_escrow", initSig);

    // TTL_SLOTS is ~800ms -- real public-RPC round-trip latency for the
    // getEscrow fetch + build + sign + send + confirm sequence can genuinely
    // exceed that window, which would make a timing-sensitive auto-tip
    // decision race against the actual on-chain landing slot. Hedge instead:
    // always attach a generous tip (well above the maximum possible
    // requirement at any point in the decay curve) so this succeeds whether
    // it lands on the fast path (where the tip is simply unused and the
    // instruction is a no-op cost) or just past it as a legitimate rescue.
    const instructions = await inertia.buildExecuteSwapInstructions({
      caller: payer.publicKey,
      escrow,
      swapInstructionData: buildSwapIx(500_000),
      remainingAccounts,
      swapProgram: mockDex.programId,
      autoAttachTip: false,
    });
    const hedgeTipIx = SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
      lamports: 40_000_000, // above the 36,000,000-lamport worst-case (keeper's full 90% share)
    });
    const tx = new Transaction().add(hedgeTipIx, ...instructions);
    const sig = await provider.sendAndConfirm(tx, [payer]);

    const afterState = await inertia.getEscrow(escrow).catch(() => null);
    record(
      afterState === null
        ? "execute_swap (landed, escrow closed -- fast path or rescue, either way a real success)"
        : "execute_swap (attempted)",
      sig
    );
  }

  // --- Flow 2: rescue after TTL, with a valid anti-snipe tip --------------
  console.log("\n=== Flow 2: keeper rescue (after TTL, valid tip) ===");
  {
    const { escrow, nonce, signature: initSig } = await inertia.initializeEscrow({
      userWallet: payer.publicKey,
      userInputTokenAccount: userInputAta,
      expectedDestinationTokenAccount: userOutputAta,
      gasBufferLamports: 40_000_000n,
      dynamicMinimumLamports: 40_000_000n,
      partnerWallet,
      inputAmount: 1_000_000n,
      expectedProgramId: mockDex.programId,
      expectedDiscriminator: new Uint8Array(discriminator),
      expectedOutputAmount: 500_000n,
    });
    record("initialize_escrow", initSig);

    const acct = await inertia.getEscrow(escrow);
    // wait past full anti-snipe decay (TTL 2 + decay 15 + margin) so a fixed
    // tip is comfortably sufficient -- mirrors the integration test suite.
    await waitSlots(Number(acct.creationSlot), 2 + 15 + 3);

    const keeper = Keypair.generate();
    await fund(keeper.publicKey, 20_000_000);

    const sig = await inertia.executeSwap(
      {
        caller: keeper.publicKey,
        escrow,
        swapInstructionData: buildSwapIx(500_000),
        remainingAccounts,
        swapProgram: mockDex.programId,
        autoAttachTip: true, // SDK computes and attaches the correct decayed tip
      },
      [keeper]
    );
    record("execute_swap (rescue path, keeper paid 90%)", sig);
  }

  // --- Flow 3: self-rescue, nobody acted -----------------------------------
  console.log("\n=== Flow 3: self_rescue (nobody acted, 150+ slots) ===");
  {
    const { escrow, signature: initSig } = await inertia.initializeEscrow({
      userWallet: payer.publicKey,
      userInputTokenAccount: userInputAta,
      expectedDestinationTokenAccount: userOutputAta,
      gasBufferLamports: 40_000_000n,
      dynamicMinimumLamports: 40_000_000n,
      partnerWallet,
      inputAmount: 1_000_000n,
      expectedProgramId: mockDex.programId,
      expectedDiscriminator: new Uint8Array(discriminator),
      expectedOutputAmount: 500_000n,
    });
    record("initialize_escrow", initSig);

    const acct = await inertia.getEscrow(escrow);
    console.log("waiting ~150 slots for the self-rescue window (~60s)...");
    await waitSlots(Number(acct.creationSlot), 150);

    const sig = await inertia.selfRescue({
      userWallet: payer.publicKey,
      escrow,
      userInputTokenAccount: userInputAta,
    });
    record("self_rescue", sig);
  }

  // --- Flow 4: permissionless cleanup, nobody acted at all -----------------
  console.log("\n=== Flow 4: cleanup_expired_escrow (300+ slots, nobody acted) ===");
  {
    const { escrow, signature: initSig } = await inertia.initializeEscrow({
      userWallet: payer.publicKey,
      userInputTokenAccount: userInputAta,
      expectedDestinationTokenAccount: userOutputAta,
      gasBufferLamports: 40_000_000n,
      dynamicMinimumLamports: 40_000_000n,
      partnerWallet,
      inputAmount: 1_000_000n,
      expectedProgramId: mockDex.programId,
      expectedDiscriminator: new Uint8Array(discriminator),
      expectedOutputAmount: 500_000n,
    });
    record("initialize_escrow", initSig);

    const acct = await inertia.getEscrow(escrow);
    console.log("waiting ~300 slots for the cleanup window (~120s)...");
    await waitSlots(Number(acct.creationSlot), 300);

    const cleaner = Keypair.generate();
    await fund(cleaner.publicKey, 5_000_000);
    const cleanerClient = new InertiaClient(
      new AnchorProvider(connection, new Wallet(cleaner), { commitment: "confirmed" })
    );
    const sig = await cleanerClient.cleanupExpiredEscrow({
      caller: cleaner.publicKey,
      escrow,
      userWallet: payer.publicKey,
    });
    record("cleanup_expired_escrow", sig);
  }

  console.log("\n=== Summary ===");
  for (const r of results) {
    console.log(`${r.label}: ${r.sig}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
