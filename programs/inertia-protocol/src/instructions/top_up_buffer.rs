use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::*;
use crate::errors::InertiaError;
use crate::state::*;

/// Callable by anyone -- user, platform, or a concerned third party -- while
/// the escrow is Pending. Covers the case where priority fees spike after
/// the escrow was created and the original buffer is no longer enough to
/// attract a keeper.
#[derive(Accounts)]
pub struct TopUpBuffer<'info> {
    #[account(mut)]
    pub contributor: Signer<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.user_wallet.as_ref(), escrow.nonce.to_le_bytes().as_ref()],
        bump = escrow.bump,
        constraint = escrow.status == EscrowStatus::Pending @ InertiaError::NotPending,
    )]
    pub escrow: Account<'info, EscrowState>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<TopUpBuffer>, amount: u64) -> Result<()> {
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.contributor.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
            },
        ),
        amount,
    )?;

    ctx.accounts.escrow.gas_buffer_lamports = ctx
        .accounts
        .escrow
        .gas_buffer_lamports
        .checked_add(amount)
        .ok_or(InertiaError::Overflow)?;

    Ok(())
}
