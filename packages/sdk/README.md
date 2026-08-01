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
