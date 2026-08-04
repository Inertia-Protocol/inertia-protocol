# Running a Keeper

A real, step-by-step walkthrough -- not just the env vars, but what to
actually expect at each step, including the parts that are supposed to
look like nothing is happening. If you just want the reference config
this repo's own proofs use, see the `devnet:keeper` / `devnet:activity`
scripts in `packages/keeper/package.json`; this doc explains what those
scripts are actually doing so you're not just trusting a black box.

## What you'll end up with

A process that scans devnet for stalled swaps against a specific DEX pool
and, once the anti-snipe math says it's actually worth it, rescues them
for a real reward. On its own, a keeper does nothing but watch -- it needs
real stalled escrows to exist before there's anything to rescue. Step 4
below covers both how that happens for real, and how to generate some
yourself so you can actually watch it work.

## Prerequisites

- Node.js and npm
- The [Solana CLI](https://docs.solanalabs.com/cli/install), for
  `solana-keygen` and `solana airdrop` -- not for building the on-chain
  program itself, which you don't need for this

## 1. Install

```bash
cd packages/sdk && npm install && npm run build
cd ../keeper && npm install && npm run build
```

The keeper depends on the SDK via a local `file:` reference, so the SDK
has to be built first.

## 2. Generate and fund a keypair

This is the identity your keeper signs transactions with, and the one
that receives the reward on every rescue -- it needs its own real SOL for
transaction fees.

```bash
solana-keygen new --outfile ~/.config/solana/my-keeper.json --no-bip39-passphrase
solana airdrop 2 ~/.config/solana/my-keeper.json --url https://api.devnet.solana.com
```

The devnet faucet rate-limits aggressively -- if the airdrop fails, wait a
few minutes and try a smaller amount, or use one of the public devnet
faucet websites. A few tenths of a SOL is enough to run for a good while;
transaction fees are small, and unlike the escrow-creation side (step 4),
running the keeper itself doesn't cost anything beyond ordinary fees.

## 3. Configure and run it

```bash
export INERTIA_KEEPER_RPC_URL="https://api.devnet.solana.com"
export INERTIA_KEEPER_KEYPAIR="$HOME/.config/solana/my-keeper.json"
export INERTIA_KEEPER_ORCA_WHIRLPOOL="122n8Kvj9htD1AkY8JWJBMngzA8rWkWDPa26vPpuiU7z"
export INERTIA_KEEPER_POLL_INTERVAL_MS="10000"  # gentler on the shared public RPC than the 2s default
npm start
```

You should see:

```
Inertia keeper bot started. Watching https://api.devnet.solana.com as <your keypair's address>
Poll interval: 10000ms, min profit: 1000 lamports
```

...and then quiet. **That's correct, not broken.** The keeper only prints
on a real rescue, a real error, or a race it just lost -- routine
"nothing eligible right now" scans are deliberately silent, so normal
operation doesn't spam the log. See
[`packages/keeper/src/index.ts`](../packages/keeper/src/index.ts) if you
want to verify that's really all it does.

`INERTIA_KEEPER_ORCA_WHIRLPOOL` is the specific pool this keeper knows how
to rescue against -- the escrow account itself doesn't store a pool
address (only the token accounts involved), and a mint pair can have
multiple real pools at different tick spacings, so this repo's bot targets
exactly one, configured up front. The address above is the same real,
live devnet pool every other proof in this repo uses.

## 4. Give it something to rescue

Nothing happens until a real escrow targeting that pool actually stalls.
Two ways that occurs:

**For real:** any platform or user that has called `initialize_escrow`
against that pool, whose swap then genuinely fails to land within
`TTL_SLOTS` (2 slots, ~800ms). You don't control this, and depending on
real traffic, it may be rare.

**To actually watch it work right now:** run the activity generator this
repo's own proof used, from a *second*, independently-funded keypair (it
pays for creating escrows -- a separate cost from running the keeper):

```bash
solana-keygen new --outfile ~/.config/solana/my-payer.json --no-bip39-passphrase
solana airdrop 2 ~/.config/solana/my-payer.json --url https://api.devnet.solana.com

# in a separate terminal, alongside the keeper from step 3:
DEVNET_PAYER=$HOME/.config/solana/my-payer.json node devnet-orca-live.mjs
```

This creates a real escrow against the same pool every 45 seconds and
deliberately never executes it -- leaving genuine work for your keeper,
running alongside it, to find and rescue on its own. Each escrow costs
about 0.045 SOL from the payer keypair (a 0.04 SOL gas buffer plus rent
and fees), so fund it accordingly for a longer run.

## 5. What you should see

Once an escrow crosses `TTL_SLOTS` and the anti-snipe tip has decayed
enough to be profitable, your keeper's next poll should log:

```
RESCUED <escrow address> -- profit ~<lamports>, tx <signature>
```

If you're running a second keeper (or someone else's is watching the same
pool), you may instead see:

```
LOST-RACE on <escrow address> -- another keeper claimed it first
```

This is expected, routine, and not an error -- it means the race
resolved safely, with the loser detecting the escrow was already closed
rather than sending a doomed transaction. See
[`docs/ECONOMIC_DESIGN.md`](./ECONOMIC_DESIGN.md) for exactly why a
"profitable" rescue can still take a few seconds to show up (the
anti-snipe tip curve), and
[`docs/ENGINEERING_LOG.md`](./ENGINEERING_LOG.md) for what running two
keepers concurrently against the same pool actually showed.

## Troubleshooting

- **`429 Too Many Requests` in the logs.** The free public devnet RPC
  rate-limits under sustained polling. Raise
  `INERTIA_KEEPER_POLL_INTERVAL_MS` further, or use a paid RPC provider
  for anything beyond casual testing -- see
  [`docs/RISK_REGISTER.md`](./RISK_REGISTER.md).
- **Nothing ever happens.** Confirm you actually have a pending escrow
  against the exact pool your keeper is configured for (step 4) -- an
  escrow targeting a different pool, or a different DEX entirely, is
  correctly ignored (`skipped-unknown-swap-program`, not logged by
  default).
- **Running low on SOL.** The devnet faucet's own rate limit is real and
  will eventually block repeated airdrop requests. If your keeper has
  already earned real rescue rewards, those are already sitting in its
  own keypair.
