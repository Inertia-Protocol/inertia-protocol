// The actual live A/B pilot: same trade, same real moment, two wallets,
// racing real mainnet contention. Side A goes through Inertia (escrow
// left deliberately stalled, rescued by a real KeeperBot instance
// watching the pool). Side B goes through mainnet-retry-baseline.mjs's
// honest-retry loop, no Inertia involved at all. Whatever happens,
// happened -- there's no simulated counterfactual on either side, both
// arms are real transactions competing for the same account at the same
// time.
//
// Safety: defaults to dry run (quotes and escrow-cost estimates only,
// nothing signed or sent on either arm). Real submission requires the
// same explicit opt-in as the retry-baseline script. This script never
// fires a real mainnet transaction on its own.
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  createAccount,
  createSyncNativeInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
  NATIVE_MINT,
} from "@solana/spl-token";
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, Wallet } = anchorPkg;
import { readFileSync, writeFileSync } from "node:fs";
import { InertiaClient } from "@inertia-protocol/sdk";
import { KeeperBot } from "./dist/bot.js";

process.env.INERTIA_RETRY_LIBRARY_MODE = "1";
const { attemptSwapWithRetry, getLivePoolQuote, RAYDIUM_CPMM_PROGRAM_ID } = await import("./mainnet-retry-baseline.mjs");

const POOL_ID = new PublicKey(process.env.INERTIA_PILOT_POOL ?? "Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp");
const CONFIG_ID = new PublicKey(process.env.INERTIA_PILOT_CONFIG ?? "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2");
const INPUT_MINT = new PublicKey(process.env.INERTIA_PILOT_INPUT_MINT ?? "So11111111111111111111111111111111111111112"); // WSOL
const SWAP_AMOUNT_LAMPORTS = BigInt(process.env.INERTIA_PILOT_AMOUNT_IN_LAMPORTS ?? "1000000"); // 0.001 SOL default, deliberately tiny
const GAS_BUFFER_LAMPORTS = BigInt(process.env.INERTIA_PILOT_BUFFER_LAMPORTS ?? "10000000"); // 0.01 SOL -- covers rent + keeper reward on a small trade
const TRIAL_COUNT = Number(process.env.INERTIA_PILOT_TRIALS ?? 1);
const RESCUE_TIMEOUT_MS = Number(process.env.INERTIA_PILOT_RESCUE_TIMEOUT_MS ?? 120_000);
const KEEPER_POLL_MS = 3_000;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Side A: create a real escrow against the pool, deliberately left Pending. */
async function createInertiaSideEscrow({ provider, inertia, userWallet, outputMint, amountIn, quote }) {
  const inputAccountKeypair = Keypair.generate();
  const destAta = getAssociatedTokenAddressSync(outputMint, userWallet.publicKey);

  await createAccount(provider.connection, userWallet, NATIVE_MINT, userWallet.publicKey, inputAccountKeypair);

  const fundTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: userWallet.publicKey,
      toPubkey: inputAccountKeypair.publicKey,
      lamports: Number(amountIn),
    }),
    createSyncNativeInstruction(inputAccountKeypair.publicKey),
    createAssociatedTokenAccountIdempotentInstruction(userWallet.publicKey, destAta, userWallet.publicKey, outputMint)
  );
  await provider.sendAndConfirm(fundTx, [userWallet]);

  // 1% slippage tolerance on the expected-output floor, matching the
  // retry-baseline arm's own SLIPPAGE_BPS default -- both arms are held
  // to the same tolerance so neither side gets an easier bar to clear.
  const expectedOutputAmount = (quote.expectedAmountOut * 9900n) / 10000n;

  const nonce = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  const { escrow, signature } = await inertia.initializeEscrow({
    userWallet: userWallet.publicKey,
    userInputTokenAccount: inputAccountKeypair.publicKey,
    expectedDestinationTokenAccount: destAta,
    gasBufferLamports: GAS_BUFFER_LAMPORTS,
    dynamicMinimumLamports: GAS_BUFFER_LAMPORTS,
    partnerWallet: userWallet.publicKey,
    inputAmount: amountIn,
    expectedProgramId: RAYDIUM_CPMM_PROGRAM_ID,
    // Extracted directly from makeSwapCpmmBaseInInstruction's own output
    // (dummy-arg call, first 8 bytes of the returned instruction data) --
    // not hand-computed or guessed. A wrong value here would make
    // execute_swap.rs's on-chain discriminator check reject every rescue
    // attempt silently.
    expectedDiscriminator: Uint8Array.from([143, 190, 90, 218, 196, 30, 51, 222]),
    expectedOutputAmount,
    nonce,
  });

  log(`[Inertia side] created escrow ${escrow.toBase58()} (tx ${signature}) -- left Pending`);
  return { escrow, createdAt: Date.now(), createSignature: signature };
}

/** Polls until the escrow closes (rescued) or the timeout elapses. Runs a real KeeperBot alongside so there's an actual watcher, not a hope that a separately-running process exists. */
async function watchForRescue({ connection, keeperBot, escrow, createdAt }) {
  const deadline = Date.now() + RESCUE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await keeperBot.runOnce();
    const info = await connection.getAccountInfo(escrow);
    if (info === null) {
      const sigs = await connection.getSignaturesForAddress(escrow, { limit: 1 });
      return {
        outcome: "rescued",
        rescuedAt: Date.now(),
        secondsToRescue: (Date.now() - createdAt) / 1000,
        closingSignature: sigs[0]?.signature ?? null,
      };
    }
    await sleep(KEEPER_POLL_MS);
  }
  return { outcome: "unrescued-timeout", secondsToRescue: null, closingSignature: null };
}

async function runOneTrial({ connection, inertiaProvider, inertiaWallet, retryWallet, keeperBot, dryRun }) {
  const quote = await getLivePoolQuote(connection, POOL_ID, INPUT_MINT, SWAP_AMOUNT_LAMPORTS);
  log(`Live quote: ${SWAP_AMOUNT_LAMPORTS} in -> ${quote.expectedAmountOut} out`);

  if (dryRun) {
    log("DRY RUN -- would create one Inertia escrow and fire one retry-baseline attempt concurrently, nothing sent.");
    return { outcome: "dry-run", quote: quote.expectedAmountOut.toString() };
  }

  const inertia = new InertiaClient(inertiaProvider);
  const startedAt = Date.now();

  // Both arms fired together -- same real moment, same real pool, same
  // real contention. Side A creates its escrow and leaves it stalled;
  // side B runs its own independent honest-retry loop. Neither observes
  // or reacts to the other; whatever lands, lands.
  const [sideAResult, sideBResult] = await Promise.allSettled([
    createInertiaSideEscrow({
      provider: inertiaProvider,
      inertia,
      userWallet: inertiaWallet,
      outputMint: quote.outputMint,
      amountIn: SWAP_AMOUNT_LAMPORTS,
      quote,
    }).then((created) => watchForRescue({ connection, keeperBot, escrow: created.escrow, createdAt: created.createdAt })),
    attemptSwapWithRetry({
      connection,
      wallet: retryWallet,
      poolId: POOL_ID,
      configId: CONFIG_ID,
      inputMint: INPUT_MINT,
      userInputTokenAccount: getAssociatedTokenAddressSync(INPUT_MINT, retryWallet.publicKey),
      userOutputTokenAccount: getAssociatedTokenAddressSync(quote.outputMint, retryWallet.publicKey),
      amountIn: SWAP_AMOUNT_LAMPORTS,
      dryRun: false,
    }),
  ]);

  return {
    outcome: "trial-complete",
    totalElapsedMs: Date.now() - startedAt,
    inertiaSide: sideAResult.status === "fulfilled" ? sideAResult.value : { outcome: "error", error: String(sideAResult.reason) },
    retrySide: sideBResult.status === "fulfilled" ? sideBResult.value : { outcome: "error", error: String(sideBResult.reason) },
  };
}

async function main() {
  const liveMode = process.env.INERTIA_PILOT_LIVE === "yes-spend-real-money";
  const rpcUrl = process.env.INERTIA_PILOT_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  log(`Mode: ${liveMode ? "LIVE -- will send real mainnet transactions on both arms" : "DRY RUN -- quote only"}`);
  log(`Pool: ${POOL_ID.toBase58()}, trials: ${TRIAL_COUNT}`);

  let inertiaWallet, retryWallet, keeperWallet, inertiaProvider, keeperBot;

  if (liveMode) {
    const need = (name) => {
      const v = process.env[name];
      if (!v) throw new Error(`${name} must be set to run live`);
      return v;
    };
    inertiaWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(need("INERTIA_PILOT_USER_WALLET"), "utf8"))));
    retryWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(need("INERTIA_PILOT_RETRY_WALLET"), "utf8"))));
    keeperWallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(need("INERTIA_PILOT_KEEPER_WALLET"), "utf8"))));

    inertiaProvider = new AnchorProvider(connection, new Wallet(inertiaWallet), {});
    keeperBot = new KeeperBot({
      rpcUrl,
      keypair: keeperWallet,
      pollIntervalMs: KEEPER_POLL_MS,
      estimatedTxFeeLamports: 10_000n,
      minProfitLamports: 1_000n,
      raydiumPoolAddress: POOL_ID,
      raydiumConfigId: CONFIG_ID,
      raydiumCpmmProgramId: RAYDIUM_CPMM_PROGRAM_ID,
    });
    log(`Inertia user wallet: ${inertiaWallet.publicKey.toBase58()}`);
    log(`Retry-baseline wallet: ${retryWallet.publicKey.toBase58()}`);
    log(`Keeper wallet: ${keeperWallet.publicKey.toBase58()}`);
  }

  const trials = [];
  for (let i = 0; i < TRIAL_COUNT; i++) {
    log(`--- Trial ${i + 1}/${TRIAL_COUNT} ---`);
    const trial = await runOneTrial({ connection, inertiaProvider, inertiaWallet, retryWallet, keeperBot, dryRun: !liveMode });
    trials.push(trial);
    log(`Trial ${i + 1} result: ${JSON.stringify(trial, null, 2)}`);
  }

  const outPath = `mainnet-ab-pilot-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), liveMode, pool: POOL_ID.toBase58(), trials }, null, 2));
  log(`Report written to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
