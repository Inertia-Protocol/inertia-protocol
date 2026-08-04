# Engineering Log

What actually changed under the hood and why, and the real bugs each real
DEX integration turned up. This is the "what was fixed" record --
`docs/INTEGRATION_GUIDE.md` is the how-to for someone integrating today;
this is the story of how that pattern was actually found.

## Generic CPI account ordering

`execute_swap` originally hardcoded its CPI account list into a fixed
4-item prefix (input token account, destination, escrow, token program)
followed by whatever extra accounts the caller supplied. That only ever
worked for a program built to match that exact order -- which `mock-dex`
was, since this repo wrote it. Solana matches CPI accounts positionally,
not by name, so a real, independently-built program like Orca Whirlpools
(whose own `swap` instruction expects
`[token_program, token_authority, whirlpool, token_owner_account_a, ...]`,
a completely different order) could not be called at all under the old
design.

`execute_swap` now takes the entire CPI account list from the caller, in
whatever order the target program actually needs. The same security
guarantees the old fixed prefix gave for free are preserved by explicit
checks: the three security-critical accounts (the escrow's real input
token account, its real expected destination, and the real SPL Token
program) must each appear somewhere in the supplied list, and the escrow's
own entry has its signer flag forced to `true` wherever it appears, since
only `invoke_signed`'s PDA seeds can actually grant that. Verified against
the existing 8-test integration suite (still 8/8) before being proven
against Orca on devnet.

This does not make `execute_swap` universally compatible, and that limit
was found for real, not assumed: `expected_discriminator` is a fixed 8
bytes, matching the now-dominant Anchor instruction-discriminator
convention. Orca Whirlpools, Raydium's newer CPMM program, and Meteora's
DLMM all use it, and all three work. Raydium's *classic* AMM program
predates Anchor and encodes its swap instruction as a single native tag
byte followed directly by the raw amount fields -- there is no stable
8-byte prefix to check at all, since those "discriminator" bytes would
actually vary with the swap amount. Confirmed by reading its real
instruction-encoding source, not assumed from docs; integrating with a
pre-Anchor program would need a further change (a configurable
discriminator length), not attempted here.

The Meteora integration also caught something the other two didn't: its
SDK derives token accounts from the swap authority (assuming authority and
token owner are always the same party), which silently pointed the built
instruction at an account the escrow doesn't own. The generalized
redesign's own new presence checks rejected it outright with
`MissingRequiredSwapAccount` rather than letting a wrong transaction
through -- a real bug the checks caught unprompted, not a hypothetical
they were designed against.

## Live dual-keeper run

A later, separate proof: two independently-keyed keeper bots run
continuously against the same live Orca pool, racing every escrow an
unattended activity generator creates. Every real race resolved to exactly
one clean winner with correct loss-detection on the losing side -- zero
double-spends, zero stuck funds. Over a larger sample the win distribution
converged toward even rather than staying locked to one side, real
evidence against the outcome being pure clock-phase determinism between
two identically-configured bots. See
[`docs/RISK_REGISTER.md`](./RISK_REGISTER.md) for exactly what this does
and doesn't prove -- it demonstrates race *safety*, and gives real (not
conclusive) evidence toward race *fairness*; it does not test real-world
keeper diversity (independent operators, varied infra and latency).

Two real operational bugs surfaced running this live, unrelated to the
protocol itself: a WSL2 background-process detachment quirk that silently
killed both the activity generator and the keeper on first attempt, and
the payer wallet running dry after ~2.5 hours of continuous funding (fixed
by recycling the keepers' own real earned rescue profit back to it, rather
than waiting on a rate-limited devnet faucet).
