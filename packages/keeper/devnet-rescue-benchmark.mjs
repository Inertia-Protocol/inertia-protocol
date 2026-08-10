// Bounded, one-shot version of devnet-orca-live.mjs's activity generator --
// creates a fixed batch of N real escrows against the same real, live Orca
// Whirlpool devnet pool, deliberately leaves every one Pending (simulating
// a swap whose follow-up transaction never landed), then measures how many
// of them the already-running keeper bots actually rescue and how long
// each one takes. This is the evidence-generating counterpart to the
// "indefinite" activity script -- same real pool, same real program, same
// buffer size, just bounded and instrumented for a report instead of left
// running forever.
//
// There is deliberately no "baseline" (no-Inertia) arm here: without
// Inertia, a stalled swap has no automated recovery mechanism at all, so
// that side of the comparison is 0% by construction, not something worth
// writing code to "prove." What this measures is the one real, honest
// number: of N deliberately-stalled swaps, how many did the keeper network
// recover with zero manual intervention, and how fast.
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, Wallet } = anchorPkg;
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAccount,
  createSyncNativeInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
} from "@solana/spl-token";
import { readFileSync, writeFileSync } from "node:fs";
import { InertiaClient } from "@inertia-protocol/sdk";

const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
// Same real, live, high-liquidity devnet pool the production keeper config
// (INERTIA_KEEPER_ORCA_WHIRLPOOL) already watches -- not a pool picked
// specially for this benchmark.
const OUTPUT_MINT = new PublicKey("9Z8PQAgh6paeYZdHfrBBsfaj4AeqNJWS8H1G19nTBB94");
const WHIRLPOOL_SWAP_DISCRIMINATOR = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);

const SWAP_AMOUNT_LAMPORTS = 5_000_000; // 0.005 SOL -- matches the live activity generator
const BUFFER_LAMPORTS = 40_000_000n; // 0.04 SOL -- matches the live activity generator
const ESCROW_COUNT = Number(process.env.INERTIA_BENCHMARK_COUNT ?? 10);
// Devnet's public RPC rate-limits WebSocket subscriptions (each
// sendAndConfirm opens one) well below what a 3s spacing produced in
// practice -- a 12-escrow run crashed with repeated 429s around escrow
// #10/11. 8s keeps the confirmation-subscription rate low enough to finish
// a full batch without needing this script's own retry logic to bail.
const CREATE_SPACING_MS = Number(process.env.INERTIA_BENCHMARK_SPACING_MS ?? 8_000);
const POLL_INTERVAL_MS = 5_000;
const MAX_WAIT_MS = 5 * 60_000; // give the keeper a generous window before calling an escrow "unrescued"

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function createOneEscrow(provider, inertia, payer, index) {
  const inputAccountKeypair = Keypair.generate();
  const destAta = getAssociatedTokenAddressSync(OUTPUT_MINT, payer.publicKey);
  const connection = provider.connection;

  await createAccount(connection, payer, NATIVE_MINT, payer.publicKey, inputAccountKeypair);

  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: inputAccountKeypair.publicKey,
      lamports: SWAP_AMOUNT_LAMPORTS,
    }),
    createSyncNativeInstruction(inputAccountKeypair.publicKey),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, destAta, payer.publicKey, OUTPUT_MINT)
  );
  await provider.sendAndConfirm(fundTx, [payer]);

  const nonce = BigInt(Date.now()) * 1000n + BigInt(index);
  const { escrow, signature } = await inertia.initializeEscrow({
    userWallet: payer.publicKey,
    userInputTokenAccount: inputAccountKeypair.publicKey,
    expectedDestinationTokenAccount: destAta,
    gasBufferLamports: BUFFER_LAMPORTS,
    dynamicMinimumLamports: BUFFER_LAMPORTS,
    partnerWallet: payer.publicKey,
    inputAmount: BigInt(SWAP_AMOUNT_LAMPORTS),
    expectedProgramId: ORCA_WHIRLPOOL_PROGRAM_ID,
    expectedDiscriminator: WHIRLPOOL_SWAP_DISCRIMINATOR,
    expectedOutputAmount: 1n,
    nonce,
  });

  log(`[${index + 1}/${ESCROW_COUNT}] created ${escrow.toBase58()} (tx ${signature}) -- left Pending`);
  return { escrow, createSignature: signature, createdAt: Date.now() };
}

async function findClosingSignature(connection, escrow) {
  // The account is gone once rescued/executed, but Solana keeps signature
  // history for the address regardless -- the most recent signature is the
  // transaction that closed it.
  const sigs = await connection.getSignaturesForAddress(escrow, { limit: 1 });
  return sigs[0]?.signature ?? null;
}

async function main() {
  const keypairPath = process.env.DEVNET_PAYER;
  if (!keypairPath) throw new Error("Set DEVNET_PAYER to a keypair JSON path");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(payer), {});
  const inertia = new InertiaClient(provider);

  log(`Devnet rescue benchmark starting. Payer: ${payer.publicKey.toBase58()}`);
  log(`Creating ${ESCROW_COUNT} real escrows against the live Orca Whirlpool pool, then measuring keeper recovery.`);

  const escrows = [];
  for (let i = 0; i < ESCROW_COUNT; i++) {
    try {
      escrows.push(await createOneEscrow(provider, inertia, payer, i));
    } catch (err) {
      log(`Error creating escrow ${i + 1} (continuing): ${err?.message ?? err}`);
    }
    if (i < ESCROW_COUNT - 1) await new Promise((r) => setTimeout(r, CREATE_SPACING_MS));
  }

  log(`All ${escrows.length} escrows created. Watching for keeper rescues (up to ${MAX_WAIT_MS / 1000}s)...`);

  const pending = new Map(escrows.map((e) => [e.escrow.toBase58(), e]));
  const results = [];
  const deadline = Date.now() + MAX_WAIT_MS;

  while (pending.size > 0 && Date.now() < deadline) {
    for (const [key, entry] of [...pending]) {
      const info = await connection.getAccountInfo(entry.escrow);
      if (info === null) {
        const rescuedAt = Date.now();
        const closingSignature = await findClosingSignature(connection, entry.escrow);
        const secondsToRescue = (rescuedAt - entry.createdAt) / 1000;
        results.push({ ...entry, rescuedAt, closingSignature, secondsToRescue, outcome: "rescued" });
        pending.delete(key);
        log(
          `RESCUED ${entry.escrow.toBase58()} in ${secondsToRescue.toFixed(1)}s -- https://explorer.solana.com/tx/${closingSignature}?cluster=devnet`
        );
      }
    }
    if (pending.size > 0) await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  for (const entry of pending.values()) {
    results.push({ ...entry, outcome: "unrescued" });
    log(`UNRESCUED (timed out) ${entry.escrow.toBase58()}`);
  }

  const rescued = results.filter((r) => r.outcome === "rescued");
  const rate = escrows.length > 0 ? (rescued.length / escrows.length) * 100 : 0;
  const avgSeconds =
    rescued.length > 0 ? rescued.reduce((sum, r) => sum + r.secondsToRescue, 0) / rescued.length : null;

  const summary = {
    ranAt: new Date().toISOString(),
    payer: payer.publicKey.toBase58(),
    pool: OUTPUT_MINT.toBase58(),
    escrowsCreated: escrows.length,
    escrowsRescued: rescued.length,
    recoveryRatePercent: Number(rate.toFixed(1)),
    averageSecondsToRescue: avgSeconds !== null ? Number(avgSeconds.toFixed(1)) : null,
    results: results.map((r) => ({
      escrow: r.escrow.toBase58(),
      createSignature: r.createSignature,
      outcome: r.outcome,
      secondsToRescue: r.secondsToRescue ?? null,
      closingSignature: r.closingSignature ?? null,
    })),
  };

  const outPath = `devnet-rescue-benchmark-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify(summary, null, 2));

  log("---- SUMMARY ----");
  log(`Created: ${summary.escrowsCreated}, Rescued: ${summary.escrowsRescued} (${summary.recoveryRatePercent}%)`);
  if (avgSeconds !== null) log(`Average time to rescue: ${summary.averageSecondsToRescue}s`);
  log(`Full report written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
