use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};
use anchor_spl::token::{self, Approve, Token, TokenAccount};

use crate::constants::*;
use crate::errors::InertiaError;
use crate::state::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct InitializeEscrowParams {
    /// Client-generated, used only to make the PDA unique per (user_wallet, escrow).
    pub nonce: u64,
    pub gas_buffer_lamports: u64,
    /// Computed off-chain by the SDK from real-time p95 priority fees (Sec. 3,
    /// Dynamic Buffer Sizing). This is a sanity/UX guard, not an adversarial
    /// check: the same party constructing this transaction supplies both this
    /// value and `gas_buffer_lamports`, so it protects against SDK bugs
    /// under-funding the escrow, not against a malicious counterparty.
    pub dynamic_minimum_lamports: u64,
    pub partner_wallet: Pubkey,
    pub input_amount: u64,
    pub expected_program_id: Pubkey,
    pub expected_discriminator: [u8; 8],
    pub expected_destination_token_account: Pubkey,
    pub expected_output_amount: u64,
}

#[derive(Accounts)]
#[instruction(params: InitializeEscrowParams)]
pub struct InitializeEscrow<'info> {
    #[account(mut)]
    pub user_wallet: Signer<'info>,

    #[account(
        mut,
        constraint = user_input_token_account.owner == user_wallet.key() @ InertiaError::UnauthorizedUser,
    )]
    pub user_input_token_account: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = user_wallet,
        space = 8 + EscrowState::INIT_SPACE,
        seeds = [ESCROW_SEED, user_wallet.key().as_ref(), params.nonce.to_le_bytes().as_ref()],
        bump,
    )]
    pub escrow: Account<'info, EscrowState>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitializeEscrow>, params: InitializeEscrowParams) -> Result<()> {
    require!(
        params.gas_buffer_lamports >= params.dynamic_minimum_lamports,
        InertiaError::BufferBelowMinimum
    );

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.key(),
            Transfer {
                from: ctx.accounts.user_wallet.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
            },
        ),
        params.gas_buffer_lamports,
    )?;

    // Delegate spending authority over exactly `input_amount` to the escrow
    // PDA. Tokens never leave the user's own account -- the user can revoke
    // this independently of Inertia at any time via a plain SPL `revoke`.
    token::approve(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            Approve {
                to: ctx.accounts.user_input_token_account.to_account_info(),
                delegate: ctx.accounts.escrow.to_account_info(),
                authority: ctx.accounts.user_wallet.to_account_info(),
            },
        ),
        params.input_amount,
    )?;

    let escrow = &mut ctx.accounts.escrow;
    escrow.user_wallet = ctx.accounts.user_wallet.key();
    escrow.partner_wallet = params.partner_wallet;
    escrow.user_input_token_account = ctx.accounts.user_input_token_account.key();
    escrow.input_amount = params.input_amount;
    escrow.expected_program_id = params.expected_program_id;
    escrow.expected_discriminator = params.expected_discriminator;
    escrow.expected_destination_token_account = params.expected_destination_token_account;
    escrow.expected_output_amount = params.expected_output_amount;
    escrow.gas_buffer_lamports = params.gas_buffer_lamports;
    escrow.creation_slot = Clock::get()?.slot;
    escrow.ttl_slots = TTL_SLOTS;
    escrow.nonce = params.nonce;
    escrow.status = EscrowStatus::Pending;
    escrow.bump = ctx.bumps.escrow;

    Ok(())
}
