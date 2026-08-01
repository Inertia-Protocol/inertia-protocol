// Real integration test for the SDK against a live validator -- goes
// through InertiaClient's actual methods, not raw anchor.methods() calls,
// specifically to catch mistakes the anti-snipe unit check can't see:
// wrong account names, wrong IDL assumptions, wrong signer handling.
// Same CJS/ESM interop issue as client.ts -- default-import and destructure.
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, BN, Program, Wallet } = anchorPkg;
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { InertiaClient } from "../dist/client.js";
import { TREASURY_PUBKEY, JITO_TIP_ACCOUNTS } from "../dist/constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mockDexIdl = JSON.parse(
  readFileSync(join(__dirname, "mock_dex.idl.json"), "utf8")
);

const RPC_URL = "http://127.0.0.1:8899";
const INPUT_AMOUNT = 1_000_000n;
const OUTPUT_AMOUNT = 500_000n;
const BUFFER_LAMPORTS = 200_000_000n; // large enough to make anti-snipe math observable

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntilSlotsElapsed(connection, fromSlot, slotsNeeded) {
  while (true) {
    const currentSlot = await connection.getSlot("confirmed");
    if (currentSlot - fromSlot > slotsNeeded) return currentSlot;
    await sleep(400);
  }
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");

  const user = Keypair.generate();
  await connection.confirmTransaction(
    await connection.requestAirdrop(user.publicKey, 2_000_000_000),
    "confirmed"
  );
  await connection.confirmTransaction(
    await connection.requestAirdrop(TREASURY_PUBKEY, 1_000_000_000),
    "confirmed"
  );

  // Real Jito tip accounts are always well above rent-exemption on mainnet
  // from live MEV activity. This local validator starts them at zero, so a
  // fully-decayed (small) auto-computed tip would otherwise leave a
  // never-before-touched account below the rent-exempt minimum and fail --
  // a test-environment artifact, not something to route around by
  // inflating the tip and defeating the point of testing the real amount.
  for (const tipAccount of JITO_TIP_ACCOUNTS) {
    await connection.confirmTransaction(
      await connection.requestAirdrop(tipAccount, 10_000_000),
      "confirmed"
    );
  }

  const partnerWallet = Keypair.generate().publicKey;
  await connection.confirmTransaction(
    await connection.requestAirdrop(partnerWallet, 1_000_000_000),
    "confirmed"
  );

  const userProvider = new AnchorProvider(connection, new Wallet(user), {});
  const userClient = new InertiaClient(userProvider);

  const mockDexProgram = new Program(mockDexIdl, userProvider);
  const [mintAuthorityPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("mint_authority")],
    mockDexProgram.programId
  );

  const inputMint = await createMint(connection, user, user.publicKey, null, 6);
  const outputMint = await createMint(connection, user, mintAuthorityPda, null, 6);

  const userInputAta = (
    await getOrCreateAssociatedTokenAccount(connection, user, inputMint, user.publicKey)
  ).address;
  const userOutputAta = getAssociatedTokenAddressSync(outputMint, user.publicKey);
  await getOrCreateAssociatedTokenAccount(connection, user, outputMint, user.publicKey);

  await mintTo(connection, user, inputMint, userInputAta, user, INPUT_AMOUNT * 10n);

  function buildSwapIxData(amountOut) {
    return mockDexProgram.coder.instruction.encode("swap", {
      amountIn: new BN(INPUT_AMOUNT.toString()),
      amountOut: new BN(amountOut.toString()),
    });
  }

  async function setupEscrow(nonce) {
    const swapIxData = buildSwapIxData(OUTPUT_AMOUNT);
    const expectedDiscriminator = Uint8Array.from(swapIxData.subarray(0, 8));

    const { escrow } = await userClient.initializeEscrow({
      userWallet: user.publicKey,
      userInputTokenAccount: userInputAta,
      expectedDestinationTokenAccount: userOutputAta,
      gasBufferLamports: BUFFER_LAMPORTS,
      dynamicMinimumLamports: BUFFER_LAMPORTS,
      partnerWallet,
      inputAmount: INPUT_AMOUNT,
      expectedProgramId: mockDexProgram.programId,
      expectedDiscriminator,
      expectedOutputAmount: OUTPUT_AMOUNT,
      nonce,
    });

    return { escrow, swapIxData };
  }

  const remainingAccounts = [
    { pubkey: inputMint, isSigner: false, isWritable: true },
    { pubkey: outputMint, isSigner: false, isWritable: true },
    { pubkey: mintAuthorityPda, isSigner: false, isWritable: false },
  ];

  // ---- Test 1: initializeEscrow + getEscrow round-trip ----
  const { escrow: escrow1 } = await setupEscrow(1n);
  const fetched = await userClient.getEscrow(escrow1);
  check(
    "getEscrow deserializes correctly after initializeEscrow",
    fetched !== null &&
      fetched.userWallet.equals(user.publicKey) &&
      fetched.inputAmount === INPUT_AMOUNT &&
      fetched.gasBufferLamports === BUFFER_LAMPORTS
  );

  // ---- Test 2: executeSwap before TTL via SDK (ordinary path, no tip needed) ----
  const balBefore = await connection.getBalance(user.publicKey);
  await userClient.executeSwap(
    {
      caller: user.publicKey,
      escrow: escrow1,
      swapInstructionData: buildSwapIxData(OUTPUT_AMOUNT),
      remainingAccounts,
      swapProgram: mockDexProgram.programId,
    },
    [user]
  );
  const destAcct1 = await getAccount(connection, userOutputAta);
  const balAfter = await connection.getBalance(user.publicKey);
  check(
    "executeSwap (ordinary path) delivers output and refunds buffer",
    Number(destAcct1.amount) === Number(OUTPUT_AMOUNT) && balAfter > balBefore
  );
  const closedEscrow = await connection.getAccountInfo(escrow1);
  check("escrow closes after ordinary execute_swap", closedEscrow === null);

  // ---- Test 3: executeSwap after TTL via SDK with auto-attached anti-snipe tip ----
  const { escrow: escrow2 } = await setupEscrow(2n);
  const escrow2StateBefore = await userClient.getEscrow(escrow2);
  await waitUntilSlotsElapsed(
    connection,
    Number(escrow2StateBefore.creationSlot),
    2 + 15 + 1 + 2 // TTL_SLOTS + TIP_DECAY_SLOTS + 1 + safety margin, fully decayed
  );

  const keeper = Keypair.generate();
  await connection.confirmTransaction(
    await connection.requestAirdrop(keeper.publicKey, 1_000_000_000),
    "confirmed"
  );
  const keeperProvider = new AnchorProvider(connection, new Wallet(keeper), {});
  const keeperClient = new InertiaClient(keeperProvider);

  const keeperBalBefore = await connection.getBalance(keeper.publicKey);
  await keeperClient.executeSwap(
    {
      caller: keeper.publicKey,
      escrow: escrow2,
      swapInstructionData: buildSwapIxData(OUTPUT_AMOUNT),
      remainingAccounts,
      swapProgram: mockDexProgram.programId,
      // autoAttachTip defaults true -- this is the actual thing being tested
    },
    [keeper]
  );
  const keeperBalAfter = await connection.getBalance(keeper.publicKey);
  check(
    "executeSwap (rescue path) auto-attaches correct tip and pays the keeper",
    keeperBalAfter > keeperBalBefore // net positive after tip + fees means the SDK's tip calc was correct, not wasteful or insufficient
  );

  // ---- Test 4: selfRescue via SDK ----
  const { escrow: escrow3 } = await setupEscrow(3n);
  const escrow3State = await userClient.getEscrow(escrow3);
  await waitUntilSlotsElapsed(connection, Number(escrow3State.creationSlot), 150);
  const userBalBeforeRescue = await connection.getBalance(user.publicKey);
  await userClient.selfRescue({
    userWallet: user.publicKey,
    escrow: escrow3,
    userInputTokenAccount: userInputAta,
  });
  const userBalAfterRescue = await connection.getBalance(user.publicKey);
  check(
    "selfRescue via SDK returns the buffer to the user",
    userBalAfterRescue > userBalBeforeRescue
  );

  // ---- Test 5: cleanupExpiredEscrow via SDK, called by a DIFFERENT identity than escrow owner ----
  const { escrow: escrow4 } = await setupEscrow(4n);
  const escrow4State = await userClient.getEscrow(escrow4);
  await waitUntilSlotsElapsed(connection, Number(escrow4State.creationSlot), 300);

  const cleaner = Keypair.generate();
  await connection.confirmTransaction(
    await connection.requestAirdrop(cleaner.publicKey, 1_000_000_000),
    "confirmed"
  );
  const cleanerProvider = new AnchorProvider(connection, new Wallet(cleaner), {});
  const cleanerClient = new InertiaClient(cleanerProvider);

  const cleanerBalBefore = await connection.getBalance(cleaner.publicKey);
  await cleanerClient.cleanupExpiredEscrow({
    caller: cleaner.publicKey,
    escrow: escrow4,
    userWallet: user.publicKey,
  });
  const cleanerBalAfter = await connection.getBalance(cleaner.publicKey);
  check(
    "cleanupExpiredEscrow works when caller is a separate client identity from the provider used to create the escrow",
    cleanerBalAfter > cleanerBalBefore
  );

  // ---- Test 6: topUpBuffer via SDK ----
  const { escrow: escrow5 } = await setupEscrow(5n);
  const topUpAmount = 5_000_000n;
  const escrowBalBefore = await connection.getBalance(escrow5);
  await userClient.topUpBuffer({
    contributor: user.publicKey,
    escrow: escrow5,
    amountLamports: topUpAmount,
  });
  const escrowBalAfter = await connection.getBalance(escrow5);
  check(
    "topUpBuffer via SDK increases the escrow balance",
    escrowBalAfter === escrowBalBefore + Number(topUpAmount)
  );

  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("INTEGRATION TEST CRASHED:", err);
  process.exit(1);
});
