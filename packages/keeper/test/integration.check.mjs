// Real end-to-end test: creates a genuinely stalled escrow, runs the actual
// KeeperBot against it, and verifies it actually finds and rescues it --
// not that the pieces look individually correct in isolation.
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, BN, Program, Wallet } = anchorPkg;

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
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

import { InertiaClient, TREASURY_PUBKEY, JITO_TIP_ACCOUNTS } from "@inertia-protocol/sdk";
import { KeeperBot } from "../dist/bot.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mockDexIdl = JSON.parse(
  readFileSync(join(__dirname, "..", "src", "idl", "mock_dex.json"), "utf8")
);

const RPC_URL = "http://127.0.0.1:8899";
const INPUT_AMOUNT = 1_000_000n;
const OUTPUT_AMOUNT = 500_000n;
const BUFFER_LAMPORTS = 200_000_000n;

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

  const swapIxData = mockDexProgram.coder.instruction.encode("swap", {
    amountIn: new BN(INPUT_AMOUNT.toString()),
    amountOut: new BN(OUTPUT_AMOUNT.toString()),
  });
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
    nonce: 1n,
  });

  // --- Keeper bot setup ---
  const keeper = Keypair.generate();
  await connection.confirmTransaction(
    await connection.requestAirdrop(keeper.publicKey, 1_000_000_000),
    "confirmed"
  );

  const bot = new KeeperBot({
    rpcUrl: RPC_URL,
    keypair: keeper,
    pollIntervalMs: 2_000,
    estimatedTxFeeLamports: 10_000n,
    minProfitLamports: 1_000n,
  });

  // --- Pass 1: too early, bot should find it but correctly leave it alone ---
  const tooEarlyResults = await bot.runOnce();
  const tooEarlyResult = tooEarlyResults.find((r) => r.escrow.equals(escrow));
  check(
    "bot discovers the escrow but does not touch it before it's profitable",
    tooEarlyResult !== undefined &&
      (tooEarlyResult.outcome === "skipped-not-eligible" ||
        tooEarlyResult.outcome === "skipped-unprofitable")
  );
  const stillPending = await userClient.getEscrow(escrow);
  check("escrow untouched after the too-early pass", stillPending !== null);

  // --- Wait until genuinely profitable (fully decayed anti-snipe window) ---
  await waitUntilSlotsElapsed(
    connection,
    Number(stillPending.creationSlot),
    2 + 15 + 1 + 2 // TTL_SLOTS + TIP_DECAY_SLOTS + 1 + safety margin
  );

  const keeperBalBefore = await connection.getBalance(keeper.publicKey);

  // --- Pass 2: should actually rescue it now ---
  const results = await bot.runOnce();
  const result = results.find((r) => r.escrow.equals(escrow));
  check("bot rescues the escrow once genuinely profitable", result?.outcome === "rescued");

  const keeperBalAfter = await connection.getBalance(keeper.publicKey);
  check("keeper's balance increased net of the tip and fees", keeperBalAfter > keeperBalBefore);

  const destAcct = await getAccount(connection, userOutputAta);
  check(
    "user's destination account actually received the swap output",
    Number(destAcct.amount) === Number(OUTPUT_AMOUNT)
  );

  const closedEscrow = await connection.getAccountInfo(escrow);
  check("escrow closed after the rescue", closedEscrow === null);

  // --- Pass 3: running again on an already-closed escrow should be a no-op, not a crash ---
  const finalResults = await bot.runOnce();
  const stillThere = finalResults.find((r) => r.escrow.equals(escrow));
  check("escrow no longer appears in a later pass (already closed)", stillThere === undefined);

  console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("INTEGRATION TEST CRASHED:", err);
  process.exit(1);
});
