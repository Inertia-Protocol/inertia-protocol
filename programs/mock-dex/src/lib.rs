//! Minimal swap-shaped program used only for local integration testing of
//! inertia-protocol's `execute_swap` CPI relay. Not part of the deployed
//! protocol, and not a real DEX -- it burns `amount_in` of the source token
//! and mints `amount_out` of the destination token, with no pricing, pool,
//! or liquidity logic at all. The point is only to prove that a program
//! `execute_swap` doesn't control can receive a CPI signed by the escrow
//! PDA's delegated authority and move tokens accordingly.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Burn, Mint, MintTo, Token, TokenAccount};

declare_id!("4uGiKQe9yiD9bCKX9nRrVZot9HkPKV7w8GN8acoAkYyP");

#[program]
pub mod mock_dex {
    use super::*;

    pub fn swap(ctx: Context<Swap>, amount_in: u64, amount_out: u64) -> Result<()> {
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Burn {
                    mint: ctx.accounts.source_mint.to_account_info(),
                    from: ctx.accounts.source.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            amount_in,
        )?;

        let bump = ctx.bumps.mint_authority;
        let seeds: &[&[u8]] = &[b"mint_authority", &[bump]];

        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                MintTo {
                    mint: ctx.accounts.output_mint.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.mint_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount_out,
        )?;

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Swap<'info> {
    #[account(mut)]
    pub source: Account<'info, TokenAccount>,
    #[account(mut)]
    pub destination: Account<'info, TokenAccount>,
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
    #[account(mut)]
    pub source_mint: Account<'info, Mint>,
    #[account(mut)]
    pub output_mint: Account<'info, Mint>,
    /// CHECK: PDA mint authority for output_mint, seeds validated by Anchor.
    #[account(seeds = [b"mint_authority"], bump)]
    pub mint_authority: UncheckedAccount<'info>,
}
