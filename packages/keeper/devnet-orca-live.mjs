// Continuous, unattended activity generator for the real Orca Whirlpools
// devnet integration. Creates a real escrow against a real, live pool on a
// timer and deliberately does NOT execute it -- the point is to leave real
// work for the actual keeper bot (devnet-orca-live-keeper via npm run
// devnet:keeper) to discover and rescue on its own, over real elapsed
// time. This is not a one-shot proof script; it's meant to run for a
// sustained stretch alongside the keeper.
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
import { readFileSync } from "node:fs";
import { InertiaClient, deriveEscrowPda } from "@inertia-protocol/sdk";

const INERTIA_PROGRAM_ID = new PublicKey("8ST3LRU5gv8ijZehvXdwRzc6VnvqbVozCCdFzEzqhqbW");
const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
// Same real, live, high-liquidity devnet pool already proven in the
// one-off Orca demo -- SOL / 9Z8PQAgh6paeYZdHfrBBsfaj4AeqNJWS8H1G19nTBB94.
const OUTPUT_MINT = new PublicKey("9Z8PQAgh6paeYZdHfrBBsfaj4AeqNJWS8H1G19nTBB94");
// Real Whirlpools "swap" discriminator, independent of any specific pool.
const WHIRLPOOL_SWAP_DISCRIMINATOR = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);

const SWAP_AMOUNT_LAMPORTS = 5_000_000; // 0.005 SOL per escrow -- small, sustainable over many cycles
const BUFFER_LAMPORTS = 40_000_000n;
const CYCLE_INTERVAL_MS = Number(process.env.INERTIA_ACTIVITY_INTERVAL_MS ?? 45_000);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function createOneEscrow(connection, provider, inertia, payer) {
  // A fresh, non-associated WSOL account per escrow -- not the standard
  // ATA, deliberately, since SPL Token's approve replaces rather than adds
  // to an existing delegation. Reusing one shared input account across
  // overlapping escrows would silently strand earlier ones (a real,
  // already-documented constraint, not new).
  const inputAccountKeypair = Keypair.generate();
  const destAta = getAssociatedTokenAddressSync(OUTPUT_MINT, payer.publicKey);

  // createAccount (spl-token) sends its own transaction; called directly
  // rather than batched, since reimplementing its two instructions by hand
  // would add complexity for no real benefit at this scale.
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

  const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
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

  log(
    `created escrow ${escrow.toBase58()} -- https://explorer.solana.com/tx/${signature}?cluster=devnet (left Pending for the keeper)`
  );
  return escrow;
}

async function main() {
  const keypairPath = process.env.DEVNET_PAYER;
  if (!keypairPath) throw new Error("Set DEVNET_PAYER to a keypair JSON path");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(payer), {});
  const inertia = new InertiaClient(provider);

  log(`Activity generator started. Payer: ${payer.publicKey.toBase58()}`);
  log(`Creating a real escrow every ${CYCLE_INTERVAL_MS / 1000}s against a real Orca Whirlpool, indefinitely.`);

  let created = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await createOneEscrow(connection, provider, inertia, payer);
      created++;
      log(`Total created this run: ${created}`);
    } catch (err) {
      log(`Error creating escrow (continuing): ${err?.message ?? err}`);
    }
    await new Promise((r) => setTimeout(r, CYCLE_INTERVAL_MS));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
