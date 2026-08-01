import { KeeperBot } from "./bot.js";
import { loadConfigFromEnv } from "./config.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
        }
        // skipped-* and lost-race outcomes are expected, routine states in
        // a permissionless system -- not logged by default to keep normal
        // operation quiet.
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
