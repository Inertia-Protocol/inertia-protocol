import { Keypair, PublicKey } from "@solana/web3.js";
import { readFileSync } from "node:fs";

export interface KeeperConfig {
  rpcUrl: string;
  keypair: Keypair;
  /** How often to scan for pending escrows, in milliseconds. */
  pollIntervalMs: number;
  /** Rough estimate of a transaction's base fee, used in the profitability check. */
  estimatedTxFeeLamports: bigint;
  /** Minimum net profit (after tip and estimated fees) required to bother attempting a rescue. */
  minProfitLamports: bigint;
  /**
   * Fixed Orca Whirlpool this bot knows how to rescue against, if set. The
   * escrow account has no stored pool address (only the token accounts
   * involved), and a given mint pair can have multiple real Whirlpools at
   * different tick spacings -- this bot targets exactly one, configured
   * up front, rather than attempting pool discovery.
   */
  orcaWhirlpoolAddress?: PublicKey;
}

const DEFAULTS = {
  pollIntervalMs: 2_000,
  estimatedTxFeeLamports: 10_000n, // conservative -- real base fee is ~5,000 lamports per signature
  minProfitLamports: 1_000n,
};

/** Loads keeper configuration from environment variables, with sane defaults for local testing. */
export function loadConfigFromEnv(): KeeperConfig {
  const rpcUrl = process.env.INERTIA_KEEPER_RPC_URL ?? "http://127.0.0.1:8899";

  const keypairPath = process.env.INERTIA_KEEPER_KEYPAIR;
  if (!keypairPath) {
    throw new Error(
      "INERTIA_KEEPER_KEYPAIR must be set to a path containing a JSON-encoded keypair (the standard Solana CLI keypair format)."
    );
  }
  const keypair = loadKeypairFromFile(keypairPath);

  return {
    rpcUrl,
    keypair,
    pollIntervalMs: process.env.INERTIA_KEEPER_POLL_INTERVAL_MS
      ? Number(process.env.INERTIA_KEEPER_POLL_INTERVAL_MS)
      : DEFAULTS.pollIntervalMs,
    estimatedTxFeeLamports: process.env.INERTIA_KEEPER_ESTIMATED_TX_FEE_LAMPORTS
      ? BigInt(process.env.INERTIA_KEEPER_ESTIMATED_TX_FEE_LAMPORTS)
      : DEFAULTS.estimatedTxFeeLamports,
    minProfitLamports: process.env.INERTIA_KEEPER_MIN_PROFIT_LAMPORTS
      ? BigInt(process.env.INERTIA_KEEPER_MIN_PROFIT_LAMPORTS)
      : DEFAULTS.minProfitLamports,
    orcaWhirlpoolAddress: process.env.INERTIA_KEEPER_ORCA_WHIRLPOOL
      ? new PublicKey(process.env.INERTIA_KEEPER_ORCA_WHIRLPOOL)
      : undefined,
  };
}

export function loadKeypairFromFile(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}
