# Worked Examples

Real code paths, not toy snippets invented for this doc -- each example
below is condensed directly from files that actually run in this repo
(`packages/keeper/devnet-orca-live.mjs`, `packages/keeper/cleanup-stale.mjs`,
`packages/keeper/src/bot.ts`, `packages/keeper/src/profitability.ts`), with
the exact SDK calls they make. Every method signature here matches
`packages/sdk/src/client.ts` as it exists today.

## 1. Create an escrow, let it stall, have a keeper rescue it

This is the full lifecycle the whole protocol exists for. On the creation
side (adapted from `devnet-orca-live.mjs`, which really does this every 45
seconds against a live Orca pool on devnet):

```ts
import { InertiaClient } from "@inertia-protocol/sdk";

const inertia = new InertiaClient(provider);

const { escrow, signature } = await inertia.initializeEscrow({
  userWallet: payer.publicKey,
  userInputTokenAccount,          // a token account only this escrow delegates from --
                                   // see the SPL-delegation footgun in the integration guide
  expectedDestinationTokenAccount,
  gasBufferLamports: 40_000_000n, // ~0.04 SOL
  dynamicMinimumLamports: 40_000_000n,
  partnerWallet: payer.publicKey,
  inputAmount: 5_000_000n,        // 0.005 SOL
  expectedProgramId: ORCA_WHIRLPOOL_PROGRAM_ID,
  expectedDiscriminator: WHIRLPOOL_SWAP_DISCRIMINATOR,
  expectedOutputAmount: 1n,
});
// Deliberately never call execute_swap here -- that's the keeper's job,
// and it's what leaves genuine work for one to actually find and do.
```

On the keeper side (this is the real branch `bot.ts`'s `tryRescue` takes
for an Orca-targeted escrow, condensed):

```ts
import { InertiaClient, OrcaSwapBuilder } from "@inertia-protocol/sdk";
import { getAccount } from "@solana/spl-token";

const orca = new OrcaSwapBuilder(provider);

// account is the EscrowStateAccount fetched from getPendingEscrows()
const inputAccountInfo = await getAccount(connection, account.userInputTokenAccount);
const { swapInstructionData, remainingAccounts } = await orca.buildSwap({
  whirlpoolAddress,
  userInputTokenAccount: account.userInputTokenAccount,
  destinationTokenAccount: account.expectedDestinationTokenAccount,
  inputMint: inputAccountInfo.mint,
  inputAmount: account.inputAmount,
  escrowAuthority: escrow,
});

// autoAttachTip defaults to true -- if this has crossed TTL_SLOTS, the SDK
// computes the exact anti-snipe tip right now and prepends it automatically.
const signature = await inertia.executeSwap(
  { caller: keeperKeypair.publicKey, escrow, swapInstructionData, remainingAccounts, swapProgram: orca.programId },
  [keeperKeypair]
);
```

`bot.ts` never attempts this blindly -- it calls `checkProfitability()`
first (real logic in `packages/keeper/src/profitability.ts`):

```ts
import { checkProfitability } from "@inertia-protocol/keeper"; // or inline the same math

const result = checkProfitability({
  gasBufferLamports: account.gasBufferLamports,
  creationSlot: account.creationSlot,
  currentSlot: await connection.getSlot(),
  estimatedTxFeeLamports: 10_000n,
  minProfitLamports: 1_000n,
});

if (!result.isRescueEligible || !result.isProfitable) {
  // skip -- either too early (TTL_SLOTS hasn't elapsed) or the anti-snipe
  // tip still eats too much of the reward right now to be worth attempting
}
```

## 2. Self-rescue

The guaranteed fallback -- works regardless of keeper availability or DEX
liquidity, once `SELF_RESCUE_SLOTS` (150 slots, ~60s) have elapsed:

```ts
const signature = await inertia.selfRescue({
  userWallet: payer.publicKey,
  escrow,
  userInputTokenAccount,
});
// Revokes the SPL delegation, sweeps the untouched buffer + rent back to
// the user in one transfer. Only user_wallet can call this -- the one
// instruction that checks caller identity.
```

## 3. Permissionlessly clean up an abandoned escrow

Real, complete code -- this is `packages/keeper/cleanup-stale.mjs` almost
verbatim, which has actually closed real leftover escrows on devnet:

```ts
const state = await inertia.getEscrow(escrow);
if (state === null) {
  // already resolved by someone else -- nothing to do
} else {
  const signature = await inertia.cleanupExpiredEscrow({
    caller: caller.publicKey,   // anyone -- this is fully permissionless
    escrow,
    userWallet: state.userWallet,
  });
  // Caller earns a 10% bounty from the untouched buffer; the remaining
  // 90% plus rent goes back to state.userWallet. Only valid once
  // CLEANUP_SLOTS (300 slots, ~120s) have elapsed with nothing else
  // having happened.
}
```

## Further reading

- [`docs/INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md) -- the pattern for building a swap-builder for a DEX not shown above.
- [`docs/INSTRUCTIONS.md`](./INSTRUCTIONS.md) -- every account, param, and error for all five instructions.
- [`docs/ECONOMIC_DESIGN.md`](./ECONOMIC_DESIGN.md) -- the actual formulas behind `gasBufferLamports`, the split, and the anti-snipe tip.
