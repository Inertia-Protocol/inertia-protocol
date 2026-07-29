# Inertia Protocol

A Solana Anchor program that rescues stalled transactions: when a swap fails to
land within 2 slots (~800ms), a public keeper gate opens and independent
keeper bots race to get it included via Jito private bundles, earning a bounty
from a dynamic gas buffer the user posted at submission time. If no keeper
acts within 150 slots, the user reclaims the full buffer via `self_rescue`.

Status: early development. Not yet deployed anywhere.

## Layout

- `programs/inertia-protocol/` — the on-chain program
- `packages/sdk/` — TypeScript integration SDK (not yet built)
- `packages/keeper/` — open source keeper bot (not yet built)
- `trident-tests/` — Trident fuzz tests for `self_rescue` and `cleanup_expired_escrow` (100k-iteration campaign, clean); `execute_swap` coverage not yet added
- `docs/` — documentation (not yet built)
