# Instruction Reference

A systematic reference for all five instructions on the on-chain program.
`docs/INTEGRATION_GUIDE.md` covers *how* to integrate; this covers exactly
*what each instruction does, requires, and can return* -- useful when you're
past the quick-start and need to know a specific account constraint or
error condition. Everything here is read directly from
`programs/inertia-protocol/src/instructions/`, not from the SDK's wrapper.

## Timing, in one place

Every threshold is a slot count, checked against `Clock::get()?.slot`, never
wall-clock time:

| Constant | Value | Meaning |
|---|---|---|
| `TTL_SLOTS` | 2 (~800ms) | Past this, `execute_swap` becomes a rescue attempt instead of an ordinary one |
| `TIP_DECAY_SLOTS` | 15 (~6s) | How long the anti-snipe required tip takes to decay from "equals the reward" back to the normal floor |
| `SELF_RESCUE_SLOTS` | 150 (~60s) | Past this, `user_wallet` can reclaim the buffer directly via `self_rescue` |
| `CLEANUP_SLOTS` | 300 (~120s) | Past this, anyone can close an untouched escrow via `cleanup_expired_escrow` |

Buffer split on a genuine rescue: 90% keeper (`KEEPER_SHARE_BPS`) / 5%
partner (`PARTNER_SHARE_BPS`) / 5% treasury (`TREASURY_SHARE_BPS`).
`cleanup_expired_escrow`'s bounty is 10% (`CLEANUP_BOUNTY_BPS`) of the
untouched buffer, with the remaining 90% plus rent going back to the user.

## `initialize_escrow`

**Who calls it:** `user_wallet`, as a real signer.
**Escrow status after:** `Pending`.

Transfers `gas_buffer_lamports` from `user_wallet` into a newly created
escrow PDA, and delegates SPL Token spending authority over exactly
`input_amount` of `user_input_token_account` to that PDA (`token::approve`
-- tokens never leave the user's own account; the user can revoke this
independently of Inertia at any time). Both `user_input_token_account` and
`expected_destination_token_account` are verified on-chain to be owned by
`user_wallet` -- a buggy or malicious platform SDK cannot point either
anywhere else.

| Param | Meaning |
|---|---|
| `nonce` | Client-generated, makes the escrow PDA unique per `(user_wallet, nonce)`. Not a signature, not stored as proof of anything. |
| `gas_buffer_lamports` | The actual bounty/refund buffer posted. |
| `dynamic_minimum_lamports` | A floor **you** compute off-chain from real-time priority fees; the contract only checks `gas_buffer_lamports >= dynamic_minimum_lamports`. Both values come from the same caller -- this is a guard against your own SDK under-funding an escrow, not an adversarial check. |
| `partner_wallet` | Gets 5% of the buffer on a genuine rescue. |
| `input_amount` | Amount delegated for the swap. |
| `expected_program_id` | The program `execute_swap`'s CPI must target. |
| `expected_discriminator` | That program's swap instruction's 8-byte Anchor discriminator. |
| `expected_output_amount` | Slippage floor, checked after the swap lands. |

**Errors it can raise:** `BufferBelowMinimum`, `UnauthorizedUser` (either
token account not owned by `user_wallet`).

## `execute_swap`

**Who calls it:** anyone, at any time while `Pending` -- permissionless by
design. Behavior branches on elapsed time, not caller identity.
**Escrow status after:** `Executed`.

- **Before `TTL_SLOTS`:** an ordinary attempt. On success, 100% of the
  buffer refunds to `user_wallet` regardless of who called it -- there's
  nothing in it for a keeper to call this early, which is what makes this
  branch self-defending without needing a caller check.
- **After `TTL_SLOTS`:** a genuine rescue. Requires a Jito tip instruction
  in the same transaction, in an amount that starts equal to the keeper's
  own reward at the earliest eligible slot and decays linearly to
  `MIN_JITO_TIP_LAMPORTS` over `TIP_DECAY_SLOTS` (see the ANTI-SNIPE design
  note in the source, and `docs/RISK_REGISTER.md` for the known residual
  griefing risk this doesn't fully close). On success, the buffer splits
  90/5/5 (caller/partner/treasury) -- payment goes straight to whichever
  key actually signed, since there's no separate stored "keeper" field to
  redirect.

Takes the entire CPI account list from the caller via `remainingAccounts`,
in whatever order the target program actually needs (see
`docs/INTEGRATION_GUIDE.md` for the full pattern). Three accounts must each
appear somewhere in that list -- the escrow's real
`user_input_token_account`, its real `expected_destination_token_account`,
and the real SPL Token program -- and the escrow's own entry has its
signer flag forced to `true` internally wherever it appears, since only
`invoke_signed`'s PDA seeds can actually grant that.

After the CPI, the destination token account's balance increase is checked
against `expected_output_amount` before any funds move.

**Errors it can raise:** `NotPending`, `InvalidSwapInstructionData` (missing
or wrong 8-byte discriminator prefix), `MissingRequiredSwapAccount` (one of
the three required accounts absent from `remainingAccounts`),
`MissingJitoTip` / tip-amount check failures on the rescue path,
`OutputBelowMinimum`, `Overflow`.

## `self_rescue`

**Who calls it:** `user_wallet` only, as a real signer -- the one
instruction where caller identity is checked.
**Escrow status after:** `Rescued`.

Past `SELF_RESCUE_SLOTS` with nothing resolved, the user can revoke the
token delegation directly (SPL Token's `Revoke` requires the token
account's actual owner, which the escrow PDA is not) and close the escrow,
sweeping both the untouched gas buffer and the rent-exempt reserve back to
themselves in one transfer. This is the guaranteed fallback -- it works
regardless of delegation state, keeper availability, or DEX liquidity.

**Errors it can raise:** `UnauthorizedUser`, `NotPending`,
`SelfRescueWindowNotElapsed`.

## `cleanup_expired_escrow`

**Who calls it:** anyone -- permissionless, including a keeper wanting the
bounty, the platform, or an unrelated third party.
**Escrow status after:** `Expired`.

Covers the case where nobody acted at all -- not a keeper, not even the
user via `self_rescue`. Past `CLEANUP_SLOTS`, any caller can close the
escrow, earning a 10% bounty from the untouched buffer; the remaining 90%
plus rent goes back to `user_wallet`. Cannot revoke the token delegation
(same reason `execute_swap` can't -- only the actual token owner can), so
the user retains that cleanup themselves whenever they choose. This exists
purely to stop abandoned escrow accounts from accumulating indefinitely,
with a real economic incentive for someone to bother.

**Errors it can raise:** `NotPending`, `CleanupWindowNotElapsed`.

## `top_up_buffer`

**Who calls it:** anyone -- user, platform, or a concerned third party --
while the escrow is `Pending`.
**Escrow status after:** unchanged (`Pending`).

Adds `amount` lamports to the existing buffer. Exists for the case where
priority fees spike after an escrow was created and the original buffer is
no longer enough to attract a keeper -- rather than the escrow being stuck
underfunded until it expires.

**Errors it can raise:** `NotPending`, `Overflow`.

## Full error reference

| Error | Raised by | Meaning |
|---|---|---|
| `BufferBelowMinimum` | `initialize_escrow` | `gas_buffer_lamports < dynamic_minimum_lamports` |
| `NotPending` | all instructions except `initialize_escrow` | Escrow isn't in `Pending` status (already executed, rescued, expired, or doesn't exist) |
| `TtlNotElapsed` | (reserved) | |
| `SelfRescueWindowNotElapsed` | `self_rescue` | Called before `SELF_RESCUE_SLOTS` have elapsed |
| `CleanupWindowNotElapsed` | `cleanup_expired_escrow` | Called before `CLEANUP_SLOTS` have elapsed |
| `MissingJitoTip` | `execute_swap` | Rescue attempt with no Jito tip instruction in the transaction |
| `MissingSwapInstruction` | (reserved) | |
| `SwapDestinationMismatch` | (reserved) | |
| `KeeperSignerMismatch` | (reserved) | |
| `UnauthorizedUser` | `initialize_escrow`, `self_rescue` | Caller or a supplied token account doesn't match the escrow's real owner |
| `Overflow` | `execute_swap`, `top_up_buffer` | Arithmetic overflow in a checked add/sub |
| `FeeSplitMismatch` | (reserved) | |
| `InvalidSwapInstructionData` | `execute_swap` | Swap instruction data missing or its first 8 bytes don't match `expected_discriminator` |
| `OutputBelowMinimum` | `execute_swap` | Swap CPI succeeded but returned less than `expected_output_amount` |
| `MissingRequiredSwapAccount` | `execute_swap` | Input token account, destination, or the real SPL Token program absent from `remainingAccounts` |

A few variants are reserved for related checks folded into the
tip-amount/decay logic rather than raised as their own distinct paths in
the current implementation; listed for completeness against the full enum
in `errors.rs`.
