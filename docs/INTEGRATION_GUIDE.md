# Integration Guide

There are two genuinely different ways to integrate with Inertia, and they
have very different amounts of work attached. Figure out which one you
actually need before reading further:

| You are... | You need | Difficulty |
|---|---|---|
| A platform whose users submit swaps and want stalled ones rescued | `initialize_escrow` only | Low -- one instruction call, no CPI or account-ordering knowledge required |
| A keeper operator, or someone adding support for a new DEX | A swap-builder client for that DEX, calling `execute_swap` | Real work -- CPI account ordering, signer-forcing, discriminator verification |

Most of this document is the second path, because that's where the real
engineering is. If you're only the first, read that section and stop --
everything after it is not your problem. Independently operated keepers
handle execution; you never call `execute_swap` yourself.

## Path 1: platform integration (initialize_escrow only)

```ts
import { InertiaClient } from "@inertia-protocol/sdk";

const inertia = new InertiaClient(provider);

const { escrow, signature } = await inertia.initializeEscrow({
  userWallet,                        // the trader
  userInputTokenAccount,             // holds the swap input -- see the footgun below
  expectedDestinationTokenAccount,   // must be owned by userWallet, verified on-chain
  gasBufferLamports,                 // the bounty/refund buffer
  dynamicMinimumLamports,            // your own floor for gasBufferLamports -- see below
  partnerWallet,                     // your platform's treasury; gets 5% on a genuine rescue
  inputAmount,                       // amount delegated for the swap
  expectedProgramId,                 // the swap program a keeper must CPI into
  expectedDiscriminator,             // that swap instruction's 8-byte Anchor discriminator
  expectedOutputAmount,              // slippage floor -- checked after the swap lands
});
```

That's the entire integration. From here:
- If the swap lands within `TTL_SLOTS` (2 slots, ~800ms) via the ordinary
  path, the full buffer refunds to `userWallet` automatically.
- If it doesn't, any independently operated keeper can pick it up and
  execute it as a rescue once the anti-snipe curve makes it profitable to do
  so -- you don't call, watch, or manage that process.
- If nothing happens within 150 slots, `userWallet` can call `self_rescue`
  directly and reclaim the buffer in full.

### `gasBufferLamports` vs `dynamicMinimumLamports`

These look redundant but aren't. `dynamicMinimumLamports` is a value **you**
compute off-chain (from real-time priority fees) and pass alongside
`gasBufferLamports` in the same call; the contract only checks that
`gasBufferLamports >= dynamicMinimumLamports`. Both numbers come from the
same party (you), so this isn't a security check against a malicious
counterparty -- it's a guard against your own SDK integration under-funding
an escrow due to a bug, which would otherwise silently produce an escrow no
keeper could ever profitably rescue.

### The one real footgun: don't reuse `userInputTokenAccount` across overlapping escrows

SPL Token's `approve` *replaces* an existing delegation rather than adding
to it. If you reuse a single input token account across two escrows that
are both still pending, creating the second one silently revokes the
first's spending authority -- not fund-losing (`self_rescue` still works
regardless of delegation state), but it strands the first escrow's
`execute_swap` path. Use a fresh, dedicated token account per escrow if a
user might have more than one in flight at once. See
[`docs/RISK_REGISTER.md`](./RISK_REGISTER.md) for the full writeup.

## Path 2: building a swap-builder client for `execute_swap`

This is the pattern actually learned by integrating three independent, real
DEXes (Orca Whirlpools, Raydium CPMM, Meteora DLMM) -- not a theoretical
checklist. Each step below names the real bug it exists to catch.

### Step 0: does the target program use 8-byte Anchor discriminators?

`EscrowState.expected_discriminator` is a fixed `[u8; 8]`. Orca, Raydium's
CPMM, and Meteora's DLMM all use the standard Anchor
`sha256("global:<ix_name>")[0..8]` convention and work today. **Verify this
against the program's actual instruction-encoding source, not its docs or
its name.** Raydium's *classic* AMM looks like a normal program but predates
Anchor entirely -- it encodes its swap instruction as a single native tag
byte directly followed by raw amount fields, with no stable 8-byte prefix at
all. That was found by reading the real source, not assumed. If the program
you're targeting doesn't use Anchor's convention, `execute_swap` cannot
target it without a contract change (a configurable discriminator length),
which does not exist yet.

### Step 1: use the DEX's raw instruction builder, never its wallet-bound convenience wrapper

Every convenience/aggregator API (Jupiter's included -- evaluated and ruled
out for exactly this reason) inserts its own setup/cleanup instructions
(SOL wrapping, ATA creation) that assume a real end user is signing the
whole transaction. At rescue time, there is no end-user signature -- only
the escrow PDA's delegated authority and the keeper's own signature. Use
the DEX SDK's low-level, single-instruction builder
(`WhirlpoolIx.swapIx`, `makeSwapCpmmBaseInInstruction`, extracting the raw
instruction out of a built `Transaction`, etc.) and discard anything that
builds more than the one swap instruction you need.

### Step 2: build `remainingAccounts` in the target program's own native order

Solana matches CPI accounts **positionally, not by name**. `execute_swap`
takes the entire CPI account list from the caller in whatever order the
target program actually needs -- there is no fixed prefix to match, unlike
this repo's own `mock-dex`. Call the DEX SDK's own instruction builder and
pass its output's account list straight through; don't try to hand-order it
yourself.

### Step 3: force the escrow's own entry to `isSigner: false` in what you submit

This is the single bug every one of the three integrations hit
independently. The DEX SDK's instruction builder marks the swap authority
(the escrow PDA) as `isSigner: true`, since it assumes ordinary wallet use.
A PDA has no private key and cannot sign at the outer-transaction level --
if you submit it as `isSigner: true`, Solana's runtime rejects the
transaction outright for an unsigned signer claim, before it even reaches
the program. `execute_swap` grants the escrow real signer status internally,
during its own `invoke_signed` CPI call, using the PDA's seeds -- that's the
only place a PDA can actually "sign." Concretely:

```ts
const remainingAccounts = rawIx.keys.map((meta) =>
  meta.pubkey.equals(escrowAuthority) ? { ...meta, isSigner: false } : meta
);
```

All three real swap-builders in this repo
([`orcaSwap.ts`](../packages/sdk/src/orcaSwap.ts),
[`raydiumCpmmSwap.ts`](../packages/sdk/src/raydiumCpmmSwap.ts),
[`meteoraDlmmSwap.ts`](../packages/sdk/src/meteoraDlmmSwap.ts)) do exactly
this, independently, because every DEX SDK's convenience builder makes the
same wallet assumption.

### Step 4: don't trust a DEX SDK's derived token accounts -- check them against the escrow's real ones

Meteora's DLMM SDK derives the input/output token accounts itself, as the
standard ATA for `(mint, authority)` -- silently assuming the swap authority
and the token owner are the same party. For Inertia's delegated-authority
pattern they aren't: the escrow PDA is the authority, but the user's real
token accounts are what actually hold the funds. This produced a built
instruction pointing at an account the escrow doesn't own at all. It was
caught by `execute_swap`'s own account-presence checks
(`MissingRequiredSwapAccount`), not missed -- but the fix belongs in the
builder, not left for the contract to reject:

```ts
const escrowDerivedInputAta = getAssociatedTokenAddressSync(inputMint, escrowAuthority, true);
// ... replace by value with the escrow's real, already-delegated account:
if (meta.pubkey.equals(escrowDerivedInputAta)) {
  return { ...meta, pubkey: userInputTokenAccount, isSigner: false };
}
```

Treat this as a class of risk, not a Meteora-specific fix: **every** new DEX
integration needs to be checked for whether its SDK assumes
authority-equals-owner, independently -- it can't be assumed safe just
because the prior integrations were fine.

### What `execute_swap` checks for you (and what it won't catch)

Regardless of what you build, `execute_swap` requires three specific
accounts to appear somewhere in your submitted `remainingAccounts` --
the escrow's real `user_input_token_account`, its real
`expected_destination_token_account`, and the real SPL Token program --
rejecting the transaction with `MissingRequiredSwapAccount` if any is
absent. This is a real safety net (it's what caught the Meteora bug above),
but it only checks *presence*, not that your account ordering or amounts
are otherwise correct for the target program. Get the account order and
signer flags right yourself; don't rely on this check to do that for you.

## What's explicitly out of scope today

See [`docs/RISK_REGISTER.md`](./RISK_REGISTER.md) for the full, current
list. The one most relevant here: pre-Anchor programs (Raydium's classic
AMM being the concrete example found) cannot be integrated without a
contract change that doesn't exist yet.

## Further reading

- [`docs/RUNNING_A_KEEPER.md`](./RUNNING_A_KEEPER.md) -- just want to run a keeper against an already-integrated DEX, not build a new one? Start there instead.
- [`docs/ENGINEERING_LOG.md`](./ENGINEERING_LOG.md) -- the contract-side story of why this design exists, and the real bugs each DEX integration turned up.
- [`packages/sdk/README.md`](../packages/sdk/README.md) -- full SDK usage, including a worked `OrcaSwapBuilder` example.
- [`docs/INSTRUCTIONS.md`](./INSTRUCTIONS.md) -- every instruction's accounts, params, and exact errors, for when you need more than the two calls shown above.
- [`docs/ECONOMIC_DESIGN.md`](./ECONOMIC_DESIGN.md) -- the actual gas-buffer, split, and anti-snipe-tip formulas behind the numbers mentioned here.
- [`docs/WORKED_EXAMPLES.md`](./WORKED_EXAMPLES.md) -- complete, real code for the full lifecycle, self-rescue, and permissionless cleanup.
- [`docs/RISK_REGISTER.md`](./RISK_REGISTER.md) -- every known open risk and limitation, kept current.
