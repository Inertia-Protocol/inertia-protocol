use anchor_lang::prelude::*;
use anchor_spl::token::{self, Revoke, Token, TokenAccount};

use crate::constants::*;
use crate::errors::InertiaError;
use crate::state::*;

/// User-only fallback once the self-rescue window has elapsed with no swap
/// executed by anyone. Unlike `execute_swap`, this can genuinely revoke the
/// delegation itself: `user_wallet` is a real signer here, and only the
/// token account's owner (never a delegate) can call SPL Token's `Revoke`.
#[derive(Accounts)]
pub struct SelfRescue<'info> {
    #[account(mut)]
    pub user_wallet: Signer<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.user_wallet.as_ref(), escrow.nonce.to_le_bytes().as_ref()],
        bump = escrow.bump,
        has_one = user_wallet @ InertiaError::UnauthorizedUser,
        constraint = escrow.status == EscrowStatus::Pending @ InertiaError::NotPending,
    )]
    pub escrow: Account<'info, EscrowState>,

    #[account(mut, address = escrow.user_input_token_account)]
    pub user_input_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<SelfRescue>) -> Result<()> {
    let elapsed = Clock::get()?
        .slot
        .saturating_sub(ctx.accounts.escrow.creation_slot);
    require!(
        elapsed > SELF_RESCUE_SLOTS,
        InertiaError::SelfRescueWindowNotElapsed
    );

    token::revoke(CpiContext::new(
        ctx.accounts.token_program.key(),
        Revoke {
            source: ctx.accounts.user_input_token_account.to_account_info(),
            authority: ctx.accounts.user_wallet.to_account_info(),
        },
    ))?;

    ctx.accounts.escrow.status = EscrowStatus::Rescued;
    // Sweeps the rent-exempt reserve AND the untouched gas buffer back to the
    // user in one transfer -- neither was ever moved out separately.
    ctx.accounts
        .escrow
        .close(ctx.accounts.user_wallet.to_account_info())?;

    Ok(())
}
