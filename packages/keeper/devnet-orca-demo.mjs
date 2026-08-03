// Real, end-to-end demo of Inertia's execute_swap against Orca Whirlpools --
// an independently-built, externally-audited DEX, not a program written for
// this project. Proves the generalized CPI account-ordering redesign works
// against a real third-party program's real account layout, not just mock-dex.
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, Wallet, Program, BN } = anchorPkg;
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  createSyncNativeInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { InertiaClient } from "@inertia-protocol/sdk";
import { OrcaSwapBuilder } from "./dist/orcaSwap.js";

const INERTIA_PROGRAM_ID = new PublicKey("8ST3LRU5gv8ijZehvXdwRzc6VnvqbVozCCdFzEzqhqbW");
// Real, live devnet Whirlpool: SOL / 9Z8PQAgh6paeYZdHfrBBsfaj4AeqNJWS8H1G19nTBB94,
// tickSpacing 64, real liquidity (~604B), independently deployed by Orca.
const WHIRLPOOL_ADDRESS = new PublicKey("122n8Kvj9htD1AkY8JWJBMngzA8rWkWDPa26vPpuiU7z");
const OUTPUT_MINT = new PublicKey("9Z8PQAgh6paeYZdHfrBBsfaj4AeqNJWS8H1G19nTBB94");
const SWAP_AMOUNT_SOL = 0.02; // real devnet SOL, wrapped ourselves ahead of time

function record(label, sig) {
  console.log(`${label}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

async function main() {
  const keypairPath = process.env.DEVNET_PAYER;
  if (!keypairPath) throw new Error("Set DEVNET_PAYER to a keypair JSON path");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(payer), {});
  const inertia = new InertiaClient(provider);
  const orca = new OrcaSwapBuilder(provider);

  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Whirlpool:", WHIRLPOOL_ADDRESS.toBase58());

  // --- Real one-time setup: wrap SOL into a real WSOL token account, and
  // create the destination ATA. Both are ordinary, separate transactions --
  // exactly the same pattern the existing test suite already uses to set up
  // token accounts before initialize_escrow, not something bundled into the
  // swap CPI itself. This is what avoids the Jupiter-style multi-instruction
  // problem: by the time execute_swap runs, both accounts already exist and
  // already hold the right balance.
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, payer.publicKey);
  const destAta = getAssociatedTokenAddressSync(OUTPUT_MINT, payer.publicKey);
  const lamportsIn = Math.floor(SWAP_AMOUNT_SOL * 1_000_000_000);

  const setupTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, wsolAta, payer.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: wsolAta, lamports: lamportsIn }),
    createSyncNativeInstruction(wsolAta),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, destAta, payer.publicKey, OUTPUT_MINT)
  );
  const setupSig = await provider.sendAndConfirm(setupTx, [payer]);
  record("setup: wrap SOL + create accounts", setupSig);

  // --- Build the real swap instruction against the real pool, with the
  // escrow PDA (not our own wallet) as tokenAuthority -- computed below
  // once we know the escrow's address, same pattern as mock-dex.
  const nonce = BigInt(Date.now());
  const [escrow] = await import("@inertia-protocol/sdk").then((m) => m.deriveEscrowPda(INERTIA_PROGRAM_ID, payer.publicKey, nonce));

  const { swapInstructionData, remainingAccounts } = await orca.buildSwap({
    whirlpoolAddress: WHIRLPOOL_ADDRESS,
    userInputTokenAccount: wsolAta,
    destinationTokenAccount: destAta,
    inputMint: NATIVE_MINT,
    inputAmount: BigInt(lamportsIn),
    escrowAuthority: escrow,
  });
  const expectedDiscriminator = swapInstructionData.subarray(0, 8);

  // Real quote already computed inside buildSwap for tick-array selection;
  // for expected_output_amount we accept anything nonzero -- Inertia's own
  // slippage floor is the safety check being demonstrated, sized generously
  // loose here since this is a liveness demo, not a slippage-tuning exercise.
  const { escrow: escrowAddr, signature: initSig } = await inertia.initializeEscrow({
    userWallet: payer.publicKey,
    userInputTokenAccount: wsolAta,
    expectedDestinationTokenAccount: destAta,
    gasBufferLamports: 40_000_000n,
    dynamicMinimumLamports: 40_000_000n,
    partnerWallet: payer.publicKey,
    inputAmount: BigInt(lamportsIn),
    expectedProgramId: orca.programId,
    expectedDiscriminator,
    expectedOutputAmount: 1n,
    nonce,
  });
  record("initialize_escrow (real Whirlpools route)", initSig);

  // Same real-latency race already hit and fixed in devnet-demo.mjs: the
  // Orca quote/pool fetches above take real time, so by the time this lands
  // on-chain the 2-slot TTL may already have elapsed. Hedge with a generous
  // fixed tip instead of trusting the timing-sensitive auto-attach.
  const instructions = await inertia.buildExecuteSwapInstructions({
    caller: payer.publicKey,
    escrow: escrowAddr,
    swapInstructionData: Buffer.from(swapInstructionData),
    remainingAccounts,
    swapProgram: orca.programId,
    autoAttachTip: false,
  });
  const hedgeTipIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
    lamports: 40_000_000, // above the 36,000,000-lamport worst case (keeper's full 90% share)
  });
  const tx = new Transaction().add(hedgeTipIx, ...instructions);
  const sig = await provider.sendAndConfirm(tx, [payer]);
  record("execute_swap (real CPI into Orca Whirlpools)", sig);

  const destBalance = await connection.getTokenAccountBalance(destAta);
  console.log("Real swap output received:", destBalance.value.uiAmountString, "of", OUTPUT_MINT.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
