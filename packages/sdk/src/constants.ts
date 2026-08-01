import { PublicKey } from "@solana/web3.js";

/**
 * Mirrors programs/inertia-protocol/src/constants.rs exactly. Kept in sync
 * by hand -- if the Rust constants change, these must change with them, or
 * the SDK's tip/timing calculations silently drift from what the on-chain
 * program actually enforces.
 */

export const ESCROW_SEED = Buffer.from("escrow");

/** Slots before the transaction is considered stalled and the keeper gate opens (~800ms). */
export const TTL_SLOTS = 2n;
/** Slots before the original user may reclaim the full buffer via self_rescue. */
export const SELF_RESCUE_SLOTS = 150n;
/** Slots before any caller may permissionlessly close an abandoned escrow. */
export const CLEANUP_SLOTS = 300n;

export const BASIS_POINTS_DIVISOR = 10_000n;
export const KEEPER_SHARE_BPS = 9_000n;
export const PARTNER_SHARE_BPS = 500n;
export const TREASURY_SHARE_BPS = 500n;
/** Applies to the remaining buffer when cleanup_expired_escrow is called. */
export const CLEANUP_BOUNTY_BPS = 1_000n;

/**
 * Protocol treasury. PLACEHOLDER -- devnet-only keypair, mirrors the current
 * value in constants.rs exactly. Must be updated here in lockstep if the
 * on-chain constant is ever replaced with a real, multisig-controlled
 * address before mainnet -- the two are not read from a single source of
 * truth today.
 */
export const TREASURY_PUBKEY = new PublicKey(
  "AX32tpNHzJsDvYvSuuT7NCiSQy6tMMyDdvrNzGYm8tYK"
);

/**
 * Minimum lamports a rescue-path tip transfer must carry once the anti-snipe
 * requirement has fully decayed. Set to Jito's own documented median
 * (50th percentile) landed-tip amount, not the bare 1,000-lamport protocol
 * floor -- see the constant's doc comment in constants.rs for the reasoning.
 */
export const MIN_JITO_TIP_LAMPORTS = 10_000n;

/**
 * Slots over which the anti-snipe required-tip requirement decays from
 * "must equal the keeper's own reward" back down to MIN_JITO_TIP_LAMPORTS.
 */
export const TIP_DECAY_SLOTS = 15n;

/**
 * Official Jito tip payment accounts (mainnet-beta / devnet, as published by
 * Jito Labs). VERIFY against https://docs.jito.wtf before relying on this in
 * production -- these are not re-derivable on-chain and rotate only rarely,
 * but a stale list here silently breaks every rescue attempt.
 */
export const JITO_TIP_ACCOUNTS: PublicKey[] = [
  new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
  new PublicKey("HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe"),
  new PublicKey("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"),
  new PublicKey("ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49"),
  new PublicKey("DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh"),
  new PublicKey("ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt"),
  new PublicKey("DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"),
  new PublicKey("3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"),
];

/** Picks one Jito tip account at random, per Jito's own recommendation (reduces contention). */
export function randomJitoTipAccount(): PublicKey {
  const index = Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length);
  return JITO_TIP_ACCOUNTS[index];
}
