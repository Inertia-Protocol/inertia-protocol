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
  /**
   * Fixed Raydium CPMM pool this bot knows how to rescue against, if set.
   * Same one-pool-configured-up-front approach as orcaWhirlpoolAddress, not
   * pool discovery.
   */
  raydiumPoolAddress?: PublicKey;
  /**
   * The AmmConfig account for raydiumPoolAddress. Raydium's own docs
   * explicitly warn against hardcoding this (it's a PDA per fee tier,
   * "amm_config" + index) and recommend resolving it per-pool via their API
   * or the PDA derivation instead -- so this is operator-supplied per pool,
   * not defaulted, the same way the pool address itself isn't guessed.
   */
  raydiumConfigId?: PublicKey;
  /**
   * Raydium CPMM program id. Defaults to the real mainnet-beta program;
   * override for devnet testing (Raydium's API doesn't serve devnet
   * pool/config data, so devnet use of this needs those values supplied
   * some other way).
   */
  raydiumCpmmProgramId: PublicKey;
}

const RAYDIUM_CPMM_MAINNET_PROGRAM_ID = new PublicKey(
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"
);

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
    raydiumPoolAddress: process.env.INERTIA_KEEPER_RAYDIUM_CPMM_POOL
      ? new PublicKey(process.env.INERTIA_KEEPER_RAYDIUM_CPMM_POOL)
      : undefined,
    raydiumConfigId: process.env.INERTIA_KEEPER_RAYDIUM_CPMM_CONFIG
      ? new PublicKey(process.env.INERTIA_KEEPER_RAYDIUM_CPMM_CONFIG)
      : undefined,
    raydiumCpmmProgramId: process.env.INERTIA_KEEPER_RAYDIUM_CPMM_PROGRAM_ID
      ? new PublicKey(process.env.INERTIA_KEEPER_RAYDIUM_CPMM_PROGRAM_ID)
      : RAYDIUM_CPMM_MAINNET_PROGRAM_ID,
  };
}

export function loadKeypairFromFile(path: string): Keypair {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}
