# Risk Register

Real, known limitations and open risks, kept here rather than left implicit or
buried in code comments. Every item below was found while actually building
and running this protocol, not hypothesized in the abstract. Status reflects
where things stand as of this writing (devnet-only, pre-audit, pre-mainnet).

## Custody and governance

### Upgrade authority is a single EOA keypair, not a multisig
The program's upgrade authority (`DGGdEdA4ug9JnHLYorvSJSAfNt5zw9CojYGHeR4sBfKu`,
confirmed via `solana program show`) is currently one personal keypair held by
the founder, not a multisig. This is a single point of failure: loss or
compromise of that one key means loss or compromise of upgrade control over
a program that holds user funds in flight.
**Status: open.** Must move to a multisig (e.g. Squads) with a defined
signer threshold before mainnet deployment or before any non-trivial value
flows through the program.

### Treasury is a devnet-only placeholder keypair
The 5% treasury share of a rescue payout currently goes to a throwaway devnet
address, not a secured production account.
**Status: open.** Must be replaced with a properly secured (likely multisig)
treasury address before mainnet.

## Security review

### No external audit has been performed
What exists today: an internal adversarial security review of the shipped
contract, plus a 100,000-iteration Trident fuzz campaign (~663,600 total
instruction invocations) across all three fund-moving instructions
(`self_rescue`, `cleanup_expired_escrow`, `execute_swap` — covering the
ordinary path, the anti-snipe decay curve at randomized points, the slippage
floor, and the account-presence checks from the CPI account-ordering
redesign), with zero assertion panics. That is real coverage, but it is not a
substitute for a third-party audit.
**Status: open.** Recommended before mainnet or before the program handles
non-trivial value.

## Protocol design — known residual risk

### Anti-snipe tip decay removes the profit motive for sniping, not the ability to act
Quoting the design note in `execute_swap.rs` directly: the rescue-path tip
requirement starts equal to the keeper's own reward at the earliest
rescue-eligible slot (making profit-seeking sniping mathematically
break-even-or-negative exactly when genuine-rescue evidence is weakest), then
decays linearly back to the normal floor over `TIP_DECAY_SLOTS` (~6 seconds).
This is a real fix for the original flat-tip design, where sniping was free
to repeat across every escrow. It is not a complete fix: a griefer willing to
eat a guaranteed loss (pay a tip ≥ the reward, gain nothing back) can still
trigger a premature rescue and redirect a specific user's buffer away from
them, with zero upside for the attacker. The attack is now bounded by cost —
it scales linearly with money spent per victim — but not eliminated.
**Status: known, documented in source, accepted residual risk pre-audit.
Revisit before mainnet.**

### Keeper race safety is proven; keeper race fairness is not
A live devnet run with two independent keeper identities racing the same
pending escrows (August 2026) confirmed the race-resolution mechanism is
*safe*: every real concurrent race produced exactly one clean `RESCUED`
outcome and correct `LOST-RACE` detection on the losing side — no
double-spends, no stuck funds, no wasted on-chain failures. It did **not**
demonstrate that races are *fair* under realistic conditions. Both test
keepers ran identical fixed-interval polling loops from the same operator;
the skewed win distribution observed is more plausibly explained by a
deterministic clock-phase relationship between two identical loops than by
genuine competitive parity, though the winner did flip at least once,
showing the outcome isn't fully locked to one side either.
**Status: open.** Real-world keeper diversity (independent operators,
varied infra, varied latency, varied polling strategy) has not been tested.

## DEX integration

### Raydium's classic (pre-Anchor) AMM cannot be integrated as-is
Confirmed by reading Raydium's real instruction-encoding source: the classic
AMM program predates the Anchor 8-byte discriminator convention and encodes
its swap instruction as a single native tag byte followed directly by raw
amount fields — there is no stable 8-byte prefix to check at all, since
`EscrowState.expected_discriminator` is a fixed `[u8; 8]` and those bytes
would vary with the swap amount on that program. Orca Whirlpools, Raydium's
newer CPMM, and Meteora's DLMM all use the Anchor convention and all three
integrate correctly today.
**Status: known limitation, explicit non-goal for the current version.**
Supporting pre-Anchor programs would need a configurable discriminator
length, which has not been built.

### Third-party DEX SDKs can silently assume authority == token owner
Meteora's DLMM SDK derives token accounts from the swap authority, assuming
authority and token owner are always the same party — which, for Inertia's
delegated-authority pattern, silently pointed a built instruction at an
account the escrow doesn't actually own. This was caught, not missed: the
generalized CPI account-ordering redesign's own presence checks rejected the
malformed transaction outright with `MissingRequiredSwapAccount` rather than
letting a wrong transaction through.
**Status: caught and handled correctly for Meteora.** This is a generic
class of risk — every future DEX integration needs to be checked for this
assumption independently; it cannot be assumed safe just because prior
integrations were fine.

## Integrator footguns

### Concurrent escrows sharing one input token account silently strand earlier ones
SPL Token's `approve` *replaces* rather than adds to an existing delegation.
If a single input token account is reused across multiple overlapping
escrows, only the most recent delegation survives — earlier escrows lose
their spending authority silently, with no explicit error at the time it
happens. This is standard SPL Token behavior, not an Inertia bug, but it is
a real footgun for integrators. The reference tooling in this repo
(`packages/keeper/devnet-orca-live.mjs`) works around it by creating a
fresh, non-associated token account per escrow.
**Status: known behavior, must be documented clearly for integrators** (not
yet enforced or checked by the contract, which has no way to detect an
approval silently overwritten by an unrelated later instruction).

### Public RPC rate limits are a real constraint for keeper operators
Sustained keeper polling against the free public devnet RPC produces
frequent `429 Too Many Requests` responses under realistic continuous
operation — observed directly and repeatedly in this repo's own live devnet
runs. On mainnet, a keeper relying on a free or shared RPC endpoint may see
degraded responsiveness exactly when responsiveness matters most (racing to
rescue).
**Status: known, external infra constraint.** Not something the protocol
itself can fix; should be called out explicitly to prospective keeper
operators (use a paid RPC provider).

## Deployment status

### Not yet on mainnet
Everything above concerns a devnet deployment. There is no production
deployment, no production monitoring or alerting, and no mainnet rollout
plan executed yet. This is the umbrella status the rest of this document
sits under, not a separate finding.
