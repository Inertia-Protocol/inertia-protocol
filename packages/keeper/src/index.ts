import { KeeperBot } from "./bot.js";
import { loadConfigFromEnv } from "./config.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A raw network blip (ECONNRESET, fetch failed) inside @solana/web3.js's
// own internal retry/reconnect logic can reject asynchronously, detached
// from the promise chain the main loop's try/catch is watching -- observed
// for real during a multi-hour devnet run, where it silently killed an
// otherwise-healthy keeper process. Node's default behavior is to crash on
// both of these; for a poll loop with no meaningful state carried between
// iterations, logging and continuing is the correct tradeoff here, not the
// general-purpose advice to always let uncaughtException take the process
// down.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection (keeper continues running):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (keeper continues running):", err);
});

async function main() {
  const config = loadConfigFromEnv();
  const bot = new KeeperBot(config);

  console.log(`Inertia keeper bot started. Watching ${config.rpcUrl} as ${config.keypair.publicKey.toBase58()}`);
  console.log(`Poll interval: ${config.pollIntervalMs}ms, min profit: ${config.minProfitLamports} lamports`);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const results = await bot.runOnce();
      for (const result of results) {
        if (result.outcome === "rescued") {
          console.log(
            `RESCUED ${result.escrow.toBase58()} -- profit ~${result.profitLamports} lamports, tx ${result.signature}`
          );
        } else if (result.outcome === "error") {
          console.error(`ERROR on ${result.escrow.toBase58()}:`, result.error);
        } else if (result.outcome === "lost-race") {
          console.log(`LOST-RACE on ${result.escrow.toBase58()} -- another keeper claimed it first`);
        }
        // skipped-* outcomes fire on essentially every pending escrow every
        // poll cycle -- logged would be pure noise. lost-race is rare and
        // meaningful (it only fires after an actual execute_swap attempt
        // was beaten), so it's worth surfacing.
      }
    } catch (err) {
      console.error("Scan pass failed:", err);
    }

    await sleep(config.pollIntervalMs);
  }
}

export { KeeperBot } from "./bot.js";
export { checkProfitability } from "./profitability.js";
export { MockDexSwapBuilder } from "./mockDexSwap.js";
export { loadConfigFromEnv, loadKeypairFromFile } from "./config.js";

// Only run the loop when executed directly (node dist/index.js), not when
// imported as a library by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Keeper bot crashed:", err);
    process.exit(1);
  });
}
