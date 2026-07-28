use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{Token, TokenAccount};
use solana_instructions_sysvar::{load_instruction_at_checked, ID as INSTRUCTIONS_SYSVAR_ID};

use crate::constants::*;
use crate::errors::InertiaError;
use crate::state::*;
use crate::util::{move_lamports, split_share};

/// Permissionless: callable by anyone, at any time while the escrow is
/// Pending. Behavior branches on whether the TTL has elapsed, not on who
/// calls it:
///
/// - Before TTL: this is the platform's own ordinary-priority attempt. On
///   success, 100% of the buffer refunds to `user_wallet` regardless of who
///   the caller was -- there is nothing in it for a keeper to call this
///   early, which is what keeps this branch self-defending.
/// - After TTL: this is a genuine rescue. Requires a Jito tip instruction
///   present in the same transaction; on success the buffer splits 90/5/5
///   (caller/partner/treasury). The caller IS the keeper -- there's no
///   separate stored keeper field to redirect, since payment goes straight
///   to whichever key actually signed this instruction.
#[derive(Accounts)]
pub struct ExecuteSwap<'info> {
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

    #[account(mut, address = escrow.partner_wallet)]
    /// CHECK: pinned via address constraint to escrow.partner_wallet
    pub partner_wallet: UncheckedAccount<'info>,

    #[account(mut, address = TREASURY_PUBKEY)]
    /// CHECK: pinned via address constraint to the hardcoded treasury constant
    pub treasury: UncheckedAccount<'info>,

    #[account(mut, address = escrow.user_input_token_account)]
    pub user_input_token_account: Account<'info, TokenAccount>,

    #[account(mut, address = escrow.expected_destination_token_account)]
    pub destination_token_account: Account<'info, TokenAccount>,

    #[account(address = escrow.expected_program_id)]
    /// CHECK: pinned via address constraint to escrow.expected_program_id; the
    /// actual instruction invoked is further constrained by the discriminator
    /// check and the post-CPI output-amount check in the handler
    pub swap_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,

    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    /// CHECK: instructions sysvar, only read via load_instruction_at_checked
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[event]
pub struct SwapExecuted {
    pub escrow: Pubkey,
    pub user_wallet: Pubkey,
    pub was_rescue: bool,
    pub caller: Pubkey,
    pub output_amount: u64,
}

pub fn handler<'info>(
    ctx: Context<'info, ExecuteSwap<'info>>,
    swap_instruction_data: Vec<u8>,
) -> Result<()> {
    require!(
        swap_instruction_data.len() >= 8
            && swap_instruction_data[0..8] == ctx.accounts.escrow.expected_discriminator,
        InertiaError::InvalidSwapInstructionData
    );

    let clock = Clock::get()?;
    let elapsed = clock.slot.saturating_sub(ctx.accounts.escrow.creation_slot);
    let is_rescue = elapsed > ctx.accounts.escrow.ttl_slots;

    if is_rescue {
        require!(
            jito_tip_present(&ctx.accounts.instructions_sysvar.to_account_info())?,
            InertiaError::MissingJitoTip
        );
    }

    let user_wallet_key = ctx.accounts.escrow.user_wallet;
    let nonce_bytes = ctx.accounts.escrow.nonce.to_le_bytes();
    let bump = ctx.accounts.escrow.bump;
    let seeds: &[&[u8]] = &[
        ESCROW_SEED,
        user_wallet_key.as_ref(),
        nonce_bytes.as_ref(),
        &[bump],
    ];

    let mut account_metas = vec![
        AccountMeta::new(ctx.accounts.user_input_token_account.key(), false),
        AccountMeta::new(ctx.accounts.destination_token_account.key(), false),
        AccountMeta::new_readonly(ctx.accounts.escrow.key(), true),
        AccountMeta::new_readonly(ctx.accounts.token_program.key(), false),
    ];
    let mut account_infos = vec![
        ctx.accounts.user_input_token_account.to_account_info(),
        ctx.accounts.destination_token_account.to_account_info(),
        ctx.accounts.escrow.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
    ];
    for acc in ctx.remaining_accounts.iter() {
        account_metas.push(AccountMeta {
            pubkey: acc.key(),
            is_signer: acc.is_signer,
            is_writable: acc.is_writable,
        });
        account_infos.push(acc.clone());
    }

    let swap_ix = Instruction {
        program_id: ctx.accounts.swap_program.key(),
        accounts: account_metas,
        data: swap_instruction_data,
    };

    let balance_before = ctx.accounts.destination_token_account.amount;
    invoke_signed(&swap_ix, &account_infos, &[seeds])?;

    ctx.accounts.destination_token_account.reload()?;
    let received = ctx
        .accounts
        .destination_token_account
        .amount
        .saturating_sub(balance_before);
    require!(
        received >= ctx.accounts.escrow.expected_output_amount,
        InertiaError::OutputBelowMinimum
    );

    let buffer = ctx.accounts.escrow.gas_buffer_lamports;
    if is_rescue {
        let keeper_share = split_share(buffer, KEEPER_SHARE_BPS)?;
        let partner_share = split_share(buffer, PARTNER_SHARE_BPS)?;
        // Treasury takes the remainder rather than its own rounded share, so
        // integer-division dust never goes unaccounted for.
        let treasury_share = buffer
            .checked_sub(keeper_share)
            .and_then(|v| v.checked_sub(partner_share))
            .ok_or(InertiaError::Overflow)?;

        move_lamports(
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.caller.to_account_info(),
            keeper_share,
        )?;
        move_lamports(
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.partner_wallet.to_account_info(),
            partner_share,
        )?;
        move_lamports(
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.treasury.to_account_info(),
            treasury_share,
        )?;
    } else {
        move_lamports(
            &ctx.accounts.escrow.to_account_info(),
            &ctx.accounts.user_wallet.to_account_info(),
            buffer,
        )?;
    }

    emit!(SwapExecuted {
        escrow: ctx.accounts.escrow.key(),
        user_wallet: user_wallet_key,
        was_rescue: is_rescue,
        caller: ctx.accounts.caller.key(),
        output_amount: received,
    });

    ctx.accounts.escrow.status = EscrowStatus::Executed;
    ctx.accounts
        .escrow
        .close(ctx.accounts.user_wallet.to_account_info())?;

    Ok(())
}

/// Checks the current transaction's top-level instructions (not CPIs -- the
/// Instructions sysvar can't see those) for a System Program transfer naming
/// one of the known Jito tip accounts.
fn jito_tip_present(instructions_sysvar: &AccountInfo) -> Result<bool> {
    let mut index = 0u16;
    loop {
        let ix = match load_instruction_at_checked(index as usize, instructions_sysvar) {
            Ok(ix) => ix,
            Err(_) => return Ok(false),
        };
        if ix.program_id == anchor_lang::system_program::ID
            && ix
                .accounts
                .iter()
                .any(|meta| JITO_TIP_ACCOUNTS.contains(&meta.pubkey))
        {
            return Ok(true);
        }
        index += 1;
    }
}
