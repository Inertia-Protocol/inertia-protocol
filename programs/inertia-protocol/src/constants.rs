use anchor_lang::prelude::*;

pub const ESCROW_SEED: &[u8] = b"escrow";

/// Slots before the transaction is considered stalled and the keeper gate opens (~800ms).
pub const TTL_SLOTS: u64 = 2;
/// Slots before the original user may reclaim the full buffer via `self_rescue`.
pub const SELF_RESCUE_SLOTS: u64 = 150;
/// Slots before any caller may permissionlessly close an abandoned escrow.
pub const CLEANUP_SLOTS: u64 = 300;

pub const BASIS_POINTS_DIVISOR: u128 = 10_000;
pub const KEEPER_SHARE_BPS: u128 = 9_000;
pub const PARTNER_SHARE_BPS: u128 = 500;
pub const TREASURY_SHARE_BPS: u128 = 500;
/// Applies to the remaining buffer when `cleanup_expired_escrow` is called (see addendum Sec. 23).
pub const CLEANUP_BOUNTY_BPS: u128 = 1_000;

/// Protocol treasury. Hardcoded and immutable post-deployment by design (Sec. 4, Instruction 6).
/// PLACEHOLDER: devnet-only keypair generated for this build. Must be replaced with a real,
/// multisig-controlled treasury address before any mainnet deployment.
pub const TREASURY_PUBKEY: Pubkey = pubkey!("AX32tpNHzJsDvYvSuuT7NCiSQy6tMMyDdvrNzGYm8tYK");

/// Minimum lamports a rescue-path tip transfer must carry to satisfy the Jito
/// check. This doesn't (and on-chain can't) prove the transaction actually
/// routed through Jito's private infrastructure rather than the public
/// mempool -- it only raises the cost of faking the check.
///
/// Set to Jito's own documented median (50th percentile) landed-tip amount
/// (see the tip_floor API example at docs.jito.wtf/lowlatencytxnsend/#tip-amount),
/// not the bare 1,000-lamport protocol floor. The floor sits below even the
/// 25th percentile of real landed tips, so it was cheaper to fake the check
/// than to pay what an actual median bundle participant pays.
pub const MIN_JITO_TIP_LAMPORTS: u64 = 10_000;

/// Slots over which the anti-snipe required-tip requirement decays from
/// "must equal the keeper's own reward" back down to MIN_JITO_TIP_LAMPORTS.
/// ~6 seconds at 400ms slots: long enough that profit-seeking sniping is
/// break-even-or-negative at the earliest possible rescue slot, short enough
/// that a genuine keeper isn't waiting anywhere near the 150-slot
/// self-rescue window to act profitably. See execute_swap's design note.
pub const TIP_DECAY_SLOTS: u64 = 15;

/// Official Jito tip payment accounts (mainnet-beta / devnet, as published by Jito Labs).
/// VERIFY against https://docs.jito.wtf before deployment. These are not re-derivable on-chain
/// and rotate only rarely, but a stale list here silently breaks the V2/V7 Jito-enforcement checks.
pub const JITO_TIP_ACCOUNTS: [Pubkey; 8] = [
    pubkey!("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
    pubkey!("HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe"),
    pubkey!("Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY"),
    pubkey!("ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49"),
    pubkey!("DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh"),
    pubkey!("ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt"),
    pubkey!("DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL"),
    pubkey!("3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"),
];
