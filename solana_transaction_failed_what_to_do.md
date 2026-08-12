## Solana Transaction Failed? Here's Why, and What to Do Right Now

If a swap or transaction just failed on Solana, you're not doing anything wrong, and you're not alone. On average, somewhere between one in five and two in five Solana transactions fail to land, and during high-volatility moments (a hot new token, a fast-moving market) that number has run as high as three in four. This is a known, structural thing about how Solana processes transactions, not a bug in your wallet.

Here's what to actually do, in order.

**1. Check what actually happened.** Paste your transaction signature (or your wallet address) into [Solscan](https://solscan.io) or [Solana Explorer](https://explorer.solana.com). You'll see one of two things:

- **It never landed at all.** No record of it on-chain. This usually means it expired before a leader ever got to it, or lost the race for space in the exact slot it needed. Nothing was charged, nothing happened. Safe to just retry.
- **It landed and reverted.** There's a real transaction there with an error attached. This usually means the price moved before your transaction executed and your slippage tolerance kicked in to protect you, or the pool state changed underneath you. A small fee may have been charged even though the swap itself didn't go through.

**2. If it never landed, retry with a fresher, more aggressive attempt.** The most common cause is simply losing a local fee auction, on Solana, fees are priced per account, not network-wide, so a busy pool can be expensive to get into even when the rest of the network is cheap. Bump your priority fee, get a fresh blockhash, and resubmit. Most wallets and swap interfaces do this automatically if you just hit retry.

**3. If it reverted on slippage, don't just retry identically.** Retrying the exact same transaction will likely fail again for the same reason, the price condition that caused the revert is probably still true. Re-check the current price, adjust your slippage tolerance if the market's moving fast, and resubmit with updated numbers.

**4. If you're trading during a launch or a fast-moving spike, expect this to happen more, not less.** This isn't a sign something's wrong with the platform you're using, it's the moments where failure rates are highest across all of Solana, not just one app.

---

**Why this keeps happening, briefly:** Solana prices transaction priority locally, per account, and doesn't queue a transaction that loses that local race, it just doesn't land. There's a lot of good tooling for improving your odds before you send (priority fee estimators, private RPCs), and almost nothing for what happens after you've already sent and it didn't work. That's the gap we're building [Inertia](https://inertia-protocol.odomushi-core.workers.dev/) to close, an escrow and keeper-bounty layer that lets a permissionless network of bots complete your swap automatically if it stalls, instead of leaving you to notice and fix it yourself.

It's not live on mainnet yet, so it won't rescue the transaction that just failed. But you can see it actually work, right now, on devnet, with your own wallet, in about 30 seconds: [try the live demo](https://inertia-protocol.odomushi-core.workers.dev/).

If you want the longer, more technical writeup on why this happens and the actual data behind it, [read it here](./solana_stalled_transactions_article.md).
