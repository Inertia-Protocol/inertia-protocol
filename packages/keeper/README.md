# @inertia-protocol/keeper

Reference open-source keeper bot for [Inertia Protocol](../../README.md).
Watches for stalled swaps and races to rescue them once it's actually
profitable to do so, not just when it's technically allowed to.

## What this actually is

This is a **reference implementation**, not a competitive production bot. Its
job is to prove the timing and profitability logic genuinely works end to
end. It isn't meant to be the fastest or only keeper. The whole point of the
protocol's bounty economics is to make it worthwhile for other, independently
operated keepers to run their own bots and compete; this one exists so the
mechanism has a working example from day one.

**The swap-execution part is explicitly pluggable.** This package keeps only
[`mockDexSwap.ts`](./src/mockDexSwap.ts), for this repo's own test-only swap
program. The three real DEX clients this bot can also drive --
[`OrcaSwapBuilder`](../sdk/src/orcaSwap.ts), `RaydiumCpmmSwapBuilder`, and
`MeteoraDlmmSwapBuilder` -- now live in
[`@inertia-protocol/sdk`](../sdk/README.md) instead of here, so any platform
or keeper operator can reuse them directly without depending on this
reference bot's internals. This bot's `bot.ts` is just one consumer of that
same public SDK surface, not a special, hardcoded case. The Orca builder is
what first proved `execute_swap`'s CPI relay actually works against a real
program's real account layout, not just one built to match Inertia's own
assumptions (see the root README's "Generic CPI account ordering" section).
Jupiter's own aggregator API was evaluated and ruled out for this
integration specifically: its convenience wrapper inserts setup instructions
(SOL wrapping, ATA creation) that require the real end user's signature,
which doesn't exist at rescue time. Whirlpools' raw `swap` instruction has no
such requirement, which is what made it a viable target.

## How it decides whether to act

Being rescue-eligible (past `TTL_SLOTS`) isn't the same as being *worth*
acting on. The anti-snipe tip curve means the required tip can still be
close to (or exceed) the reward early in the decay window. See
[`profitability.ts`](./src/profitability.ts): it estimates the actual reward,
subtracts the currently-required tip and an estimated transaction fee, and
only attempts a rescue if what's left clears a configurable minimum profit.

## Running it

```bash
cd packages/keeper
npm install
npm run build

export INERTIA_KEEPER_RPC_URL="http://127.0.0.1:8899"   # defaults to this if unset
export INERTIA_KEEPER_KEYPAIR="/path/to/keeper-keypair.json"  # required, standard Solana CLI format
export INERTIA_KEEPER_MIN_PROFIT_LAMPORTS="1000"          # optional, defaults shown

npm start
```

It runs a continuous scan loop: fetch every pending escrow, check
profitability for each, attempt a rescue on the profitable ones, repeat.
Losing a race to another keeper (the escrow closes between the scan and the
attempt landing) is treated as an expected, routine outcome in a
permissionless system, not an error, and the bot just moves on.

## Testing

```bash
# Pure profitability-math check, no external dependencies:
npm test

# Real end-to-end check -- creates a genuinely stalled escrow, runs the
# actual bot against it, and verifies it finds and rescues it. Requires
# surfpool running with both programs deployed (see the root CONTRIBUTING.md):
npm run test:integration
```
