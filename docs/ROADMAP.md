# Roadmap

Not built. This is a vision document for where the write-lock-collision
problem could go beyond Inertia's current scope, not a spec for something
in progress. Nothing below has a line of code behind it yet.

## Lanes -- a sealed-bid write-lock auction for liquidations

### The gap: Solana's local fee markets have no coordination mechanism, only a race

Solana's fee market is priced per writable account, not network-wide. When
multiple transactions want to write to the same account, they compete in a
local, real-time auction on that specific account, while the rest of the
network stays cheap. This is deliberate design ([Helius: "The Truth about
Solana Local Fee Markets"](https://www.helius.dev/blog/solana-local-fee-markets)),
and it's what makes Solana's parallel execution model work at all. But it
has a specific, provable failure mode: the losers of that local auction
don't get queued, refunded, or rescheduled. They land on-chain as failed
transactions, having already burned real fees, compute units, and block
space, and having crowded out everyone else trying to use that same slot.

This is the mechanism behind a stat Helius reports directly: addresses
sending 100,000+ transactions a day (bots) generate 95.2% of all reverted
transactions on Solana. Reverted non-vote transaction share peaked at
75.7% in April 2024 and had only fallen to 41.2% by December 2024. The
same piece documents fee unpredictability directly from this dynamic: in
November 2024, the mean priority fee was 0.0003 SOL against a median of
0.00000861 SOL -- a 35x gap, meaning a handful of hot accounts absorb
almost all the contention while everything else stays nearly free. This is
the same underlying mechanic behind the ISSTA 2025 numbers Inertia already
cites: bots fail 58.43% of the time versus 6.22% for humans, and 47.99% of
all failures are "price or profit not met" -- the failure signature of
losing a race for the same opportunity.

Solana core has tried to price this problem away and hasn't shipped a fix.
[SIMD-110](https://github.com/solana-foundation/solana-improvement-documents/pull/110),
which would have added an exponential, burnt fee for holding a write lock
on a contended account, was proposed by Anza in January 2024 and is closed,
not merged. The write-lock race is exactly as unpriced and uncoordinated
today as it was when the proposal was written.

Where this gets expensive, not just wasteful: liquidations are one of the
highest-stakes cases of exactly this race, because the accounts under
contention during a crash (a lending pool's obligation accounts, the
oracle account feeding it) are the same accounts every liquidator,
arbitrageur, and panicking user is trying to write to at once. On November
9, 2022, Solend had a $29.7M loan against $32.6M in SOL collateral that
needed roughly $2M liquidated to stay solvent, and couldn't reliably
liquidate it because "Solana is currently congested with oracle updates
being intermittent"
([The Block](https://www.theblock.co/post/184646/solend-struggling-to-liquidate-sol-loan-due-to-congestion)).
That's the write-lock race threatening actual protocol solvency, not just
a failed swap.

There's no clean, systematic dollar total for "bad debt caused specifically
by liquidation collision" the way Inertia has a clean average-failure-rate
number -- that figure doesn't appear to exist yet as a published study.
What exists is the general bot-failure mechanism (ISSTA, Helius), the fact
that liquidations sit squarely inside that mechanism, and one
well-documented, dollar-denominated incident where it nearly caused
insolvency. Flagging that gap rather than papering over it.

### The mechanism: a sealed-bid write-lock auction, resolved before anyone touches the hot account

Actors: the borrower (has the position), the lending protocol (integrates
the primitive), competing keepers (permissionless, today they just race),
and the Lane program itself -- a small, non-custodial on-chain PDA, not a
relayer or sequencer.

Instead of every keeper submitting a full liquidation transaction and
racing for the obligation account's write lock (today's status quo, where
N-1 of N attempts fail and still cost real fees and block space), keepers
first submit a sealed bid to a separate, low-contention side-account during
a short commit window. Bids are hash-committed
(`hash(bid_amount, keeper_pubkey, salt)`), not plaintext, and carry a bond.
After the commit window closes (enforced by slot height, not wall-clock
time), a reveal window opens; the program picks the winner from revealed
bids and issues a short-lived, single-use authorization that only the
winner can spend to execute the actual liquidation instruction in the
following slot. Only one transaction ever touches the hot account's write
lock. Losing bonds are refunded automatically since the program custodies
nothing beyond the bond itself.

**Trust model:** fully non-custodial. Collateral never leaves the lending
protocol's normal vaults. Bonds sit in a PDA the Lane program controls by
code, not by any operator. No off-chain sequencer, no privileged relayer,
no allowlist.

**Economic loop:** the winning keeper still earns the liquidation discount
(Kamino's is roughly 5%) minus their bid. The lending protocol earns fewer
collision-driven failed liquidations and less bad-debt exposure, which it
can turn into a marketable feature the same way Jupiter Lend already
markets its single-transaction batch liquidation engine as enabling higher
LTVs and lower penalties.

### The adversarial pass

**Naive version:** an open, plaintext bid ("highest bid wins, bids visible
during the commit window"). Solana has no private mempool; a
latency-advantaged party (validator-colocated infrastructure, the kind
that already exists in Solana's MEV ecosystem) can watch pending bid
transactions in gossip/QUIC and simply submit one lamport higher just
before the window closes. This reproduces exactly the problem the
mechanism was built to remove: whoever has the fastest pipe always wins,
and ordinary keepers are racing a rigged auction instead of a rigged
mempool. Shortening the commit window doesn't fix this; it makes it worse,
since it advantages the party operating on the shortest timescale by
definition.

**The fix:** sealed bids via commit-reveal, with reveal only accepted in a
window that opens strictly after commits close. A bid is informationally
worthless to a competitor until it's revealed, and by the time it's
revealed, no new commitments are possible. There's nothing left to snipe.
Same class of fix as Inertia's own decay-from-reward insight: don't patch
a race condition by tuning parameters, remove the information the attacker
needs.

**Second-order exploit:** commit-and-vanish griefing, where a keeper (or
colluding group) floods the commit window with bids they never reveal,
denying the lane to real competitors. **Fix:** bonds are posted at commit
time and forfeited to a protocol-controlled treasury (not to the attacker)
if unrevealed by the deadline. Griefing becomes strictly costly with no
offsetting benefit.

### Why this has to be permissionless, not a centralized allowlist

The cheap engineering shortcut is obvious: run a private liquidator
allowlist or an off-chain sequencer that assigns liquidation rights.
Strictly easier to build than a commit-reveal PDA. Also commercially dead
on arrival for this specific use case, because credibly-neutral,
permissionless liquidation is a security property that lending protocols
already advertise as a selling point (Kamino, Solend, and MarginFi all
do). A centralized assignment layer turns the protocol operator into a
censor, a single point of failure, and a plausible front-runner of its own
liquidations -- precisely the trust assumption depositors and auditors are
checking for. The mechanism only has value to a lending protocol if it's
at least as trust-minimized as the blind race it replaces.

### Honest residual risk

This removes write-lock collision as a cause of failed or delayed
liquidations. It does not remove:

- **Leader censorship.** If a leader for the entire commit+reveal window
  simply omits all Lane-related transactions, the lane fails to resolve
  within its window and the protocol needs a timeout fallback to a direct
  blind-race liquidation -- the exact status quo this was built to improve
  on.
- **A fixed latency cost.** Sealed commit-reveal needs at least two
  sequential windows, meaning roughly 1-2 seconds of added latency at
  Solana's ~400ms slot time before a guaranteed-unique liquidation
  executes, versus a hypothetical (if lawless) zero-latency race. For an
  oracle gap large and fast enough (a >20% jump in under a second, which
  has happened in past exploit events), that latency alone could be enough
  to cross from "healthy discount" into bad debt. No coordination
  mechanism can outrun the price move itself. This fixes the collision
  tax, not fundamental gap risk.

### The wedge

The first integrators are lending protocols with real TVL and real
insurance-fund exposure (Kamino at roughly $3.5B TVL per RedStone's
December 2025 report, MarginFi, Solend, Jupiter Lend). The pitch is
direct and self-interested, not altruistic: fewer collision-driven failed
liquidation attempts, measurably lower bad-debt exposure, a marketable
capital-efficiency story the way Jupiter Lend already sells its
liquidation engine. Integration is one CPI into an existing liquidation
instruction; existing keeper bots need an SDK change to bid instead of
racing blind, with zero change to end-user UX. Independently
benchmarkable pre-launch, replaying historical high-volatility windows on
devnet the same way this repo already benchmarks Inertia's rescue rate
(see [devnet-rescue-benchmark.mjs](../packages/keeper/devnet-rescue-benchmark.mjs)),
reporting the delta in collision-driven failures and bad-debt-minutes.

The growth loop is two-sided the way Jito's was: keeper operators mostly
run bots across multiple protocols simultaneously, so each new protocol
integration lowers the marginal cost for operators to adopt the pattern
everywhere, and once one large protocol can publicly show a lower bad-debt
track record through a crash, competitors face direct depositor-flow
pressure to match it before the next one.

### How this differs from Inertia -- structurally, not cosmetically

Inertia recovers a specific, already-known, already-failed transaction
after the fact, for an individual user, via escrow and a decaying bounty.
Lanes would intervene before submission, for a class of mutually
competing actors racing for the same resource, via sealed-bid coordination
with no escrow of user funds at all. One is post-failure recovery for an
individual; the other is pre-collision coordination for a market of
competitors. They could plausibly coexist in the same wallet-infra stack
without overlapping.

### Sources

- [Zheng et al., "Why Does My Transaction Fail?", ISSTA 2025](https://dl.acm.org/doi/10.1145/3728943) / [arXiv](https://arxiv.org/abs/2504.18055)
- [Helius, "The Truth about Solana Local Fee Markets"](https://www.helius.dev/blog/solana-local-fee-markets)
- [The Block, "Solend struggling to liquidate SOL loan due to congestion," Nov 2022](https://www.theblock.co/post/184646/solend-struggling-to-liquidate-sol-loan-due-to-congestion)
- [SIMD-110: Exponential fee for write lock accounts (closed)](https://github.com/solana-foundation/solana-improvement-documents/pull/110)
- [RedStone, "Solana Lending Markets Report 2025"](https://blog.redstone.finance/2025/12/11/solana-lending-markets/)
