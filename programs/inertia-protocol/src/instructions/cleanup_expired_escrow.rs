use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::InertiaError;
use crate::state::*;
use crate::util::{move_lamports, split_share};

/// Permissionless cleanup for escrows nobody ever acted on -- not even the
/// user via `self_rescue`. Pays the caller a 10% bounty from the untouched
/// buffer as an incentive to keep state from accumulating indefinitely; the
/// remaining 90% plus the rent-exempt reserve goes back to the user via close.
///
/// Cannot revoke the token delegation, same reason as `execute_swap`: only
/// the token account's owner (user_wallet, not a signer here) can revoke it.
/// The user retains that cleanup themselves whenever they choose.
#[derive(Accounts)]
pub struct CleanupExpiredEscrow<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.user_wallet.as_ref(), escrow.nonce.to_le_bytes().as_ref()],
        bump = escrow.bump,
        constraint = escrow.status == EscrowStatus::Pending @ InertiaError::NotPending,
    )]
    pub escrow: Account<'info, EscrowState>,

    #[account(mut, address = escrow.user_wallet)]
    /// CHECK: pinned via address constraint to escrow.user_wallet
    pub user_wallet: UncheckedAccount<'info>,
}

pub fn handler(ctx: Context<CleanupExpiredEscrow>) -> Result<()> {
    let elapsed = Clock::get()?
        .slot
        .saturating_sub(ctx.accounts.escrow.creation_slot);
    require!(
        elapsed > CLEANUP_SLOTS,
        InertiaError::CleanupWindowNotElapsed
    );

    let bounty = split_share(ctx.accounts.escrow.gas_buffer_lamports, CLEANUP_BOUNTY_BPS)?;
    move_lamports(
        &ctx.accounts.escrow.to_account_info(),
        &ctx.accounts.caller.to_account_info(),
        bounty,
    )?;

    ctx.accounts.escrow.status = EscrowStatus::Expired;
    // Sweeps the remaining 90% of the buffer plus the rent-exempt reserve
    // back to the user in one transfer.
    ctx.accounts
        .escrow
        .close(ctx.accounts.user_wallet.to_account_info())?;

    Ok(())
}
