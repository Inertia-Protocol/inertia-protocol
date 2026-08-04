# Economic Design

The actual formulas that decide who gets paid what, and why, with real
numbers from a live devnet run rather than illustrative ones. Everything
below is read directly from `programs/inertia-protocol/src/instructions/execute_swap.rs`,
`programs/inertia-protocol/src/util.rs`, and `programs/inertia-protocol/src/constants.rs`.

## Where the money comes from

The user posts `gas_buffer_lamports` at `initialize_escrow` time -- a
single pool of lamports that funds every possible outcome: the refund, the
keeper's reward, the partner's cut, the treasury's cut, and the cleanup
bounty. Nothing else is minted or moved from anywhere else.

`dynamic_minimum_lamports`, passed in the same call, is a floor the
*caller itself* computes off-chain from real-time priority fees. The
contract only checks `gas_buffer_lamports >= dynamic_minimum_lamports` --
since both numbers come from the same party, this is a guard against your
own SDK under-funding an escrow by mistake, not a check against an
adversarial counterparty.

## The split

```rust
// constants.rs
pub const KEEPER_SHARE_BPS: u128 = 9_000;   // 90%
pub const PARTNER_SHARE_BPS: u128 = 500;    // 5%
pub const TREASURY_SHARE_BPS: u128 = 500;   // 5%
pub const CLEANUP_BOUNTY_BPS: u128 = 1_000; // 10%
```

| Path | Who gets what |
|---|---|
| Ordinary (`execute_swap`, before `TTL_SLOTS`) | 100% of the buffer refunded to `user_wallet`. Nothing to the caller -- there's no incentive to call this early, which is what keeps this path self-defending without a caller check. |
| Rescue (`execute_swap`, after `TTL_SLOTS`) | 90% to the caller (the keeper), 5% to `partner_wallet`, 5% to the hardcoded treasury. |
| `self_rescue` | 100% of the buffer plus the rent-exempt reserve, back to the user. |
| `cleanup_expired_escrow` | 10% bounty to the caller, 90% plus rent back to the user. |

`split_share` (`util.rs`) computes each cut as
`(total as u128) * share_bps / 10_000`, and on the rescue path the
treasury takes whatever's left after the keeper and partner shares are
subtracted -- rather than its own separately-rounded share -- so integer
division never leaves dust unaccounted for.

## The anti-snipe tip curve

This is the actual mechanism, not a simplified description of it:

```rust
// execute_swap.rs
fn anti_snipe_required_tip(keeper_share: u64, slots_into_rescue: u64) -> u64 {
    let decay_progress = slots_into_rescue.saturating_sub(1);
    if keeper_share <= MIN_JITO_TIP_LAMPORTS || decay_progress >= TIP_DECAY_SLOTS {
        return MIN_JITO_TIP_LAMPORTS;
    }
    let remaining_slots = TIP_DECAY_SLOTS - decay_progress;
    let extra_above_floor = keeper_share - MIN_JITO_TIP_LAMPORTS;
    MIN_JITO_TIP_LAMPORTS + extra_above_floor.saturating_mul(remaining_slots) / TIP_DECAY_SLOTS
}
```

At the very first rescue-eligible slot, the required tip equals
`keeper_share` -- the reward itself -- so claiming it costs at least as
much as it pays. Pure profit-seeking sniping is break-even-or-negative
exactly when genuine-rescue evidence is weakest. From there it decays
*linearly* down to `MIN_JITO_TIP_LAMPORTS` over `TIP_DECAY_SLOTS` (15
slots, ~6 seconds), so a real keeper doesn't have to wait anywhere near
the 150-slot self-rescue window to act profitably.

`MIN_JITO_TIP_LAMPORTS` is set to 10,000 -- Jito's own documented median
(50th percentile) landed-tip amount, not the bare 1,000-lamport protocol
floor. That floor sits below even the 25th percentile of real landed
tips, so it was cheaper to fake the "was this actually a Jito bundle"
check than to pay what an actual median participant pays; the real median
closes that gap.

The client-side SDK (`antiSnipe.ts`) mirrors this formula exactly in
TypeScript (`BigInt` throughout, to match Rust's `u64`/`u128` semantics),
so `InertiaClient.executeSwap()` can compute and attach the correct tip
automatically -- a keeper never hand-calculates this curve itself.

## What this actually looked like live

From the dual-keeper devnet run (`docs/ENGINEERING_LOG.md`), every escrow
that run created posted a `gas_buffer_lamports` of exactly 40,000,000, so
`keeper_share = split_share(40_000_000, 9_000) = 36,000,000` lamports for
all of them. Two real, fully-verifiable examples from that run's actual
keeper log, working backward from `profit = keeper_share - tip -
estimated_tx_fee` (fee estimate: the keeper's default 10,000 lamports):

- [`Ct5YpGqM...`](https://explorer.solana.com/tx/544iBW6bUw4mKM29rELQiDNe9PEbeRbZdPDRWGLGveFL6pxGQ5kkcnuZxvA6aZqzzmSmviCn32m9oMTogSZ61kJF?cluster=devnet) logged `profit ~21584000`. Working backward: `tip = 36,000,000 - 10,000 - 21,584,000 = 14,406,000`, which solves the decay formula exactly at `slots_into_rescue = 10` -- this keeper landed the rescue exactly 10 slots (~4 seconds) into the decay window.
- [`7cDxqS6P...`](https://explorer.solana.com/tx/2QisWWB2rctzZ5mFEGULSZFt4rvPmjbfAuAixBw1rnyicAgRjgpdMyvpoe2sqwrdn8wx4ef5pov5wky94T4NokjT?cluster=devnet) logged `profit ~14386000`. Same math gives `tip = 21,604,000`, solving exactly at `slots_into_rescue = 7`.
- The great majority of rescues in that run logged `profit ~35980000` -- the fully-decayed case: `tip = MIN_JITO_TIP_LAMPORTS (10,000)`, giving `36,000,000 - 10,000 - 10,000 = 35,980,000` exactly.

(The `profit ~N` figures in the keeper's own log are `estimatedProfitLamports`, computed at scan time -- a real, honest estimate, not necessarily bit-identical to the final landed outcome if timing shifted between the scan and the transaction landing. The two worked examples above solve to clean integer slot counts, which is why they're used here rather than every logged figure.)

## Known residual risk

The tip curve removes the *profit motive* for sniping, not the *ability*
to act -- a griefer willing to eat a guaranteed loss can still trigger a
premature rescue. This is a known, accepted, pre-audit risk, not
something this document glosses over. Full writeup:
[`docs/RISK_REGISTER.md`](./RISK_REGISTER.md).
