// The "honest retry" arm of the live A/B pilot -- what a sophisticated
// platform already does when a swap doesn't land, with no Inertia
// involved at all. A real wallet signs directly, no escrow, no CPI.
//
// "Honest" means every retry actually re-does the two things a naive
// retry skips: a FRESH blockhash (never reused across attempts) and a
// RE-QUOTED route (the pool's live reserves are re-read and re-priced
// through Raydium's own CurveCalculator every attempt, not the original
// quote resent blind). Priority fee also escalates each attempt. This is
// the strongest realistic baseline to hold Inertia's rescue path to, not
// a strawman -- benchmarking against something weaker than this is the
// exact thing a real trading platform's engineers would see through
// immediately.
//
// Safety: defaults to a dry run (quote-only, no signing, no spending).
// Real submission requires an explicit opt-in (see main()) -- this script
// never fires a real mainnet transaction on its own.
import { Connection, Transaction, ComputeBudgetProgram, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import {
  CpmmPoolInfoLayout,
  CpmmConfigInfoLayout,
  CurveCalculator,
  makeSwapCpmmBaseInInstruction,
  getCreatePoolKeys,
} from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { readFileSync, writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";

const RAYDIUM_CPMM_PROGRAM_ID = new PublicKey("CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

const MAX_ATTEMPTS = Number(process.env.INERTIA_RETRY_MAX_ATTEMPTS ?? 5);
const CONFIRM_TIMEOUT_MS = Number(process.env.INERTIA_RETRY_CONFIRM_TIMEOUT_MS ?? 20_000);
const SLIPPAGE_BPS = Number(process.env.INERTIA_RETRY_SLIPPAGE_BPS ?? 100); // 1%
const BASE_PRIORITY_FEE_MICROLAMPORTS = Number(process.env.INERTIA_RETRY_BASE_PRIORITY_FEE ?? 10_000);
const PRIORITY_FEE_BUMP_MULTIPLIER = 2; // doubles each retry -- a real, aggressive repricing strategy, not a token gesture

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Reads the pool's live on-chain reserves and fee config and re-quotes
 * through Raydium's own CurveCalculator -- the same math their program
 * uses on-chain, not a hand-rolled approximation of it. Read-only, no
 * signing, safe to call as many times as needed.
 */
async function getLivePoolQuote(connection, poolId, inputMint, amountIn) {
  const poolAccountInfo = await connection.getAccountInfo(poolId);
  if (!poolAccountInfo) throw new Error(`Pool ${poolId.toBase58()} not found`);
  const pool = CpmmPoolInfoLayout.decode(poolAccountInfo.data);

  const configAccountInfo = await connection.getAccountInfo(pool.configId);
  if (!configAccountInfo) throw new Error(`Config ${pool.configId.toBase58()} not found`);
  const config = CpmmConfigInfoLayout.decode(configAccountInfo.data);

  const aToB = inputMint.equals(pool.mintA);
  const inputVault = aToB ? pool.vaultA : pool.vaultB;
  const outputVault = aToB ? pool.vaultB : pool.vaultA;
  const outputMint = aToB ? pool.mintB : pool.mintA;

  const [inputVaultAccount, outputVaultAccount] = await Promise.all([
    getAccount(connection, inputVault),
    getAccount(connection, outputVault),
  ]);

  const swapResult = CurveCalculator.swapBaseInput(
    new BN(amountIn.toString()),
    new BN(inputVaultAccount.amount.toString()),
    new BN(outputVaultAccount.amount.toString()),
    config.tradeFeeRate,
    config.creatorFeeRate,
    config.protocolFeeRate,
    config.fundFeeRate,
    true
  );

  return {
    pool,
    config,
    outputMint,
    inputVault,
    outputVault,
    inputVaultAmount: BigInt(inputVaultAccount.amount.toString()),
    outputVaultAmount: BigInt(outputVaultAccount.amount.toString()),
    expectedAmountOut: BigInt(swapResult.outputAmount.toString()),
  };
}

function buildSwapInstruction({ pool, poolId, configId, walletPubkey, userInputTokenAccount, userOutputTokenAccount, inputVault, outputVault, inputMint, outputMint, amountIn, minimumAmountOut }) {
  const keys = getCreatePoolKeys({
    poolId,
    programId: RAYDIUM_CPMM_PROGRAM_ID,
    configId,
    mintA: pool.mintA,
    mintB: pool.mintB,
  });

  // walletPubkey signs directly at the outer transaction level -- unlike
  // RaydiumCpmmSwapBuilder in the SDK, which strips the signer flag
  // because Inertia's escrow PDA can only sign via CPI. There's no escrow
  // here, so the natural signer flag from the SDK's own instruction
  // builder is exactly correct and left untouched.
  return makeSwapCpmmBaseInInstruction(
    RAYDIUM_CPMM_PROGRAM_ID,
    walletPubkey,
    keys.authority,
    configId,
    poolId,
    userInputTokenAccount,
    userOutputTokenAccount,
    inputVault,
    outputVault,
    TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    inputMint,
    outputMint,
    pool.observationId,
    new BN(amountIn.toString()),
    new BN(minimumAmountOut.toString())
  );
}

/**
 * The actual honest-retry loop: fresh blockhash, re-quoted route, bumped
 * priority fee, every attempt. Returns after the first landed attempt or
 * after MAX_ATTEMPTS is exhausted.
 */
async function attemptSwapWithRetry({ connection, wallet, poolId, configId, inputMint, userInputTokenAccount, userOutputTokenAccount, amountIn, dryRun }) {
  const attempts = [];
  const startedAt = Date.now();

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const attemptStart = Date.now();
    try {
      const quote = await getLivePoolQuote(connection, poolId, inputMint, amountIn);
      const minimumAmountOut = (quote.expectedAmountOut * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
      const priorityFeeMicrolamports = Math.round(
        BASE_PRIORITY_FEE_MICROLAMPORTS * Math.pow(PRIORITY_FEE_BUMP_MULTIPLIER, attempt - 1)
      );

      log(
        `Attempt ${attempt}: quoted ${amountIn} in -> ${quote.expectedAmountOut} out (min ${minimumAmountOut}), priority fee ${priorityFeeMicrolamports} microlamports/CU`
      );

      if (dryRun) {
        attempts.push({
          attempt,
          outcome: "dry-run-quote-only",
          expectedAmountOut: quote.expectedAmountOut.toString(),
          minimumAmountOut: minimumAmountOut.toString(),
          priorityFeeMicrolamports,
        });
        continue;
      }

      const swapIx = buildSwapInstruction({
        pool: quote.pool,
        poolId,
        configId,
        walletPubkey: wallet.publicKey,
        userInputTokenAccount,
        userOutputTokenAccount,
        inputVault: quote.inputVault,
        outputVault: quote.outputVault,
        inputMint,
        outputMint: quote.outputMint,
        amountIn,
        minimumAmountOut,
      });

      const tx = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicrolamports }),
        swapIx
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = wallet.publicKey;
      tx.sign(wallet);

      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      log(`Attempt ${attempt}: sent ${signature}`);

      const confirmation = await Promise.race([
        connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed"),
        sleep(CONFIRM_TIMEOUT_MS).then(() => ({ timedOut: true })),
      ]);

      const elapsedMs = Date.now() - attemptStart;

      if (confirmation.timedOut) {
        attempts.push({ attempt, signature, outcome: "timeout", priorityFeeMicrolamports, elapsedMs });
        log(`Attempt ${attempt}: timed out waiting for confirmation`);
        continue;
      }
      if (confirmation.value?.err) {
        attempts.push({
          attempt,
          signature,
          outcome: "reverted",
          error: JSON.stringify(confirmation.value.err),
          priorityFeeMicrolamports,
          elapsedMs,
        });
        log(`Attempt ${attempt}: reverted -- ${JSON.stringify(confirmation.value.err)}`);
        continue;
      }

      attempts.push({
        attempt,
        signature,
        outcome: "landed",
        priorityFeeMicrolamports,
        elapsedMs,
        expectedAmountOut: quote.expectedAmountOut.toString(),
      });
      log(`Attempt ${attempt}: LANDED (${signature}), total ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      return { outcome: "landed", attempts, totalElapsedMs: Date.now() - startedAt };
    } catch (err) {
      attempts.push({ attempt, outcome: "error", error: err?.message ?? String(err), elapsedMs: Date.now() - attemptStart });
      log(`Attempt ${attempt}: error -- ${err?.message ?? err}`);
    }
  }

  if (!dryRun) log(`All ${MAX_ATTEMPTS} attempts exhausted, never landed.`);
  return { outcome: dryRun ? "dry-run-complete" : "never-landed", attempts, totalElapsedMs: Date.now() - startedAt };
}

async function main() {
  const keypairPath = process.env.INERTIA_RETRY_WALLET;
  const poolIdStr = process.env.INERTIA_RETRY_POOL ?? "Q2sPHPdUWFMg7M7wwrQKLrn619cAucfRsmhVJffodSp"; // WSOL/USELESS CPMM, found for the pilot
  const configIdStr = process.env.INERTIA_RETRY_CONFIG ?? "D4FPEruKEHrG5TenZ2mpDGEfu1iUvTiqBxvpU8HLBvC2";
  const inputMintStr = process.env.INERTIA_RETRY_INPUT_MINT ?? "So11111111111111111111111111111111111111112"; // WSOL
  const amountIn = BigInt(process.env.INERTIA_RETRY_AMOUNT_IN_LAMPORTS ?? "1000000"); // 0.001 SOL default -- deliberately tiny
  // Real submission requires this exact opt-in -- absence of it, or any
  // other value, keeps this in quote-only dry-run mode. No implicit path
  // to spending real money.
  const liveMode = process.env.INERTIA_RETRY_LIVE === "yes-spend-real-money";

  const connection = new Connection(process.env.INERTIA_RETRY_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
  const poolId = new PublicKey(poolIdStr);
  const configId = new PublicKey(configIdStr);
  const inputMint = new PublicKey(inputMintStr);

  log(`Mode: ${liveMode ? "LIVE -- will send real mainnet transactions" : "DRY RUN -- quote only, nothing sent"}`);
  log(`Pool: ${poolId.toBase58()}, input mint: ${inputMint.toBase58()}, amount in: ${amountIn}`);

  let wallet = null;
  let userInputTokenAccount, userOutputTokenAccount;

  if (liveMode) {
    if (!keypairPath) throw new Error("INERTIA_RETRY_WALLET must be set to run live");
    wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));
    if (!process.env.INERTIA_RETRY_INPUT_TOKEN_ACCOUNT || !process.env.INERTIA_RETRY_OUTPUT_TOKEN_ACCOUNT) {
      throw new Error("INERTIA_RETRY_INPUT_TOKEN_ACCOUNT and INERTIA_RETRY_OUTPUT_TOKEN_ACCOUNT must be set to run live");
    }
    userInputTokenAccount = new PublicKey(process.env.INERTIA_RETRY_INPUT_TOKEN_ACCOUNT);
    userOutputTokenAccount = new PublicKey(process.env.INERTIA_RETRY_OUTPUT_TOKEN_ACCOUNT);
    log(`Wallet: ${wallet.publicKey.toBase58()}`);
  } else {
    // Dry run needs no wallet or token accounts -- it only reads pool state and quotes.
    wallet = { publicKey: PublicKey.default };
  }

  const result = await attemptSwapWithRetry({
    connection,
    wallet,
    poolId,
    configId,
    inputMint,
    userInputTokenAccount,
    userOutputTokenAccount,
    amountIn,
    dryRun: !liveMode,
  });

  const outPath = `retry-baseline-${Date.now()}.json`;
  writeFileSync(outPath, JSON.stringify({ ranAt: new Date().toISOString(), liveMode, ...result }, null, 2));
  log(`Result: ${result.outcome}. Report written to ${outPath}`);
}

export { attemptSwapWithRetry, getLivePoolQuote, RAYDIUM_CPMM_PROGRAM_ID };

// Same opt-out-to-import pattern as index.ts -- this file is both a
// standalone script (npm-run directly for a solo retry-baseline check)
// and a module the A/B orchestration script imports for its retry arm.
// Without the guard, importing it would also fire off main()'s own CLI
// parsing and (in live mode) a real transaction, which an importer
// controlling its own trial loop should never trigger as a side effect.
if (process.env.INERTIA_RETRY_LIBRARY_MODE !== "1") {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
