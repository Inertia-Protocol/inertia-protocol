# @inertia-protocol/sdk

TypeScript client SDK for [Inertia Protocol](../../README.md). Wraps all five
on-chain instructions and, most importantly, mirrors the contract's anti-snipe
tip-decay math client-side so callers don't have to reimplement it by hand.

## Install

Not published to npm yet. Used as a workspace-local package within this
monorepo. From the repo root:

```bash
cd packages/sdk
npm install
npm run build
```

## Usage

```ts
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { InertiaClient } from "@inertia-protocol/sdk";

const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const wallet = new Wallet(Keypair.generate()); // or your real signer
const provider = new AnchorProvider(connection, wallet, {});

const inertia = new InertiaClient(provider);

// Create an escrow
const { escrow, nonce } = await inertia.initializeEscrow({
  userWallet: wallet.publicKey,
  userInputTokenAccount /* your token account */,
  expectedDestinationTokenAccount /* your ATA for the output mint */,
  gasBufferLamports: 40_000_000n,
  dynamicMinimumLamports: 40_000_000n,
  partnerWallet /* your integration partner's wallet */,
  inputAmount: 1_000_000n,
  expectedProgramId /* the swap program's ID */,
  expectedDiscriminator /* that swap instruction's 8-byte discriminator */,
  expectedOutputAmount: 500_000n,
});

// Later -- executed by anyone, ordinary or rescue path decided on-chain by
// elapsed time. If this is a rescue, the SDK automatically computes and
// attaches the correct anti-snipe tip -- you don't need to calculate it.
await inertia.executeSwap(
  {
    caller: wallet.publicKey,
    escrow,
    swapInstructionData /* the underlying swap program's instruction data */,
    remainingAccounts /* whatever accounts that swap program's CPI needs */,
    swapProgram: expectedProgramId,
  },
  [wallet.payer]
);
```

## What the SDK actually gives you beyond a thin wrapper

`executeSwap()` (and `buildExecuteSwapInstructions()` if you want the raw
instructions instead of an auto-sent transaction) fetches the escrow's live
state, checks whether this is a rescue attempt, and if so computes the exact
tip required by the contract's decay curve right now, starting at the
keeper's own reward at the earliest eligible slot, decaying to the normal
floor over `TIP_DECAY_SLOTS`. See [`antiSnipe.ts`](./src/antiSnipe.ts) for the
implementation and the top-level [README](../../README.md#how-it-works) for
why this exists.

See [`docs/INTEGRATION_GUIDE.md`](../../docs/INTEGRATION_GUIDE.md) for the
full pattern behind these builders (why each one forces `isSigner: false` on
the escrow's own entry, how to verify a new DEX uses 8-byte Anchor
discriminators before attempting it, and the account-substitution class of
bug the Meteora integration caught) -- this section is just the quick-start.

## Real DEX swap-builder clients

`executeSwap` needs `swapInstructionData` and `remainingAccounts` for
whatever DEX program the escrow targets -- the SDK ships real, working
builders for the three DEXes this protocol has proven against, so an
integrator doesn't have to work out each program's account ordering and
CPI-signer quirks from scratch:

- [`OrcaSwapBuilder`](./src/orcaSwap.ts) -- [Orca Whirlpools](https://www.orca.so/), concentrated liquidity
- [`RaydiumCpmmSwapBuilder`](./src/raydiumCpmmSwap.ts) -- Raydium's CPMM, flat constant-product
- [`MeteoraDlmmSwapBuilder`](./src/meteoraDlmmSwap.ts) -- Meteora's DLMM, discrete-bin liquidity

```ts
import { InertiaClient, OrcaSwapBuilder } from "@inertia-protocol/sdk";

const orca = new OrcaSwapBuilder(provider);
const { swapInstructionData, remainingAccounts } = await orca.buildSwap({
  whirlpoolAddress /* the specific pool to swap through */,
  userInputTokenAccount: account.userInputTokenAccount,
  destinationTokenAccount: account.expectedDestinationTokenAccount,
  inputMint /* looked up from userInputTokenAccount, not stored on the escrow */,
  inputAmount: account.inputAmount,
  escrowAuthority: escrow,
});

await inertia.executeSwap(
  { caller: wallet.publicKey, escrow, swapInstructionData, remainingAccounts, swapProgram: orca.programId },
  [wallet.payer]
);
```

Each builder independently handles the same real constraint: the underlying
DEX SDK's own instruction builder marks the swap authority (the escrow PDA)
as `isSigner: true`, assuming ordinary wallet use -- a PDA has no keypair and
cannot sign at the outer-transaction level, only `execute_swap`'s own
`invoke_signed` can grant that during the CPI itself. Each builder forces
that flag back to `false` before returning, so the outer transaction Solana
actually verifies never wrongly claims the escrow can sign for itself. See
[`docs/RISK_REGISTER.md`](../../docs/RISK_REGISTER.md) for the specific,
real bugs each of these three integrations turned up (a Raydium
discriminator incompatibility ruled out rather than worked around, and a
Meteora account-substitution bug this pattern caught directly), and for
what's still explicitly out of scope (Raydium's classic, pre-Anchor AMM).

This package's `packages/keeper` reference bot is just one consumer of
these same exports, not a special case -- any platform or independent
keeper operator can import them directly.

## One thing to know about signing

Most methods (`selfRescue`, `cleanupExpiredEscrow`, `topUpBuffer`,
`initializeEscrow`) sign with the `AnchorProvider`'s own wallet; there's no
separate signer parameter. `cleanupExpiredEscrow` is permissionless on-chain
(anyone can call it), so if you want to call it as a different identity than
whatever your main provider is configured with, construct a second
`InertiaClient` with a provider built from that identity's own wallet. This
is verified to work, see `test/integration.check.mjs`.

`executeSwap` is the one method that does accept an explicit signers array,
since it's the instruction most likely to be called by a keeper bot managing
many different signing identities.

## Testing

```bash
# Pure math check, no external dependencies:
npm test

# Real end-to-end check against a live validator -- requires surfpool
# running with both programs deployed first (see the root CONTRIBUTING.md):
npm run test:integration
```
