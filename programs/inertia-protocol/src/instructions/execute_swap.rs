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
///   present in the same transaction, in an amount that starts at the
///   keeper's own reward and decays to a floor over TIP_DECAY_SLOTS (see the
///   ANTI-SNIPE design note in the handler below); on success the buffer
///   splits 90/5/5 (caller/partner/treasury). The caller IS the keeper --
///   there's no separate stored keeper field to redirect, since payment goes
///   straight to whichever key actually signed this instruction.
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
    ///
    /// KNOWN SCALABILITY NOTE (not a security issue, not urgent): this is a
    /// single global account written on every rescue-path execute_swap call,
    /// across every escrow. Per-escrow PDAs don't contend with each other,
    /// but they all contend on this write lock -- Solana's per-account CU
    /// cap (fixed at 12M regardless of overall block capacity) bounds how
    /// much simultaneous rescue volume can actually land in one slot. A
    /// claim-and-sweep pattern (record an amount owed instead of
    /// transferring directly, let the treasury claim periodically) removes
    /// this from the hot path if it ever matters. Nowhere near that volume
    /// today; revisit before real scale, not before mainnet specifically.
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

    // ANTI-SNIPE TIP REQUIREMENT: TTL_SLOTS=2 matches real MEV-bot "needs
    // intervention" thresholds (not arbitrary), so a bot doesn't need genuine
    // rescue capability to win the flat-tip version of this check -- only to
    // be fast. Instead of a flat MIN_JITO_TIP_LAMPORTS, the required tip
    // starts equal to the keeper's own reward at the earliest rescue-eligible
    // slot -- making profit-seeking sniping mathematically break-even-or-
    // negative right when genuine-rescue evidence is weakest -- then decays
    // linearly back to the normal floor over TIP_DECAY_SLOTS (~6 seconds), so
    // a real keeper can still act quickly once the ratio clears. See
    // anti_snipe_required_tip below for the exact curve.
    //
    // KNOWN RESIDUAL RISK (pre-audit): this removes the PROFIT motive, not
    // the ability to act. A griefer willing to eat a guaranteed loss (pay
    // tip >= reward, gain nothing back) can still trigger a premature rescue
    // and redirect a specific user's buffer away from them, with zero upside
    // for the attacker. Bounded by cost -- griefing scales linearly with money
    // spent per victim, unlike the original flat-tip bug where sniping was
    // free to repeat across every escrow -- but not eliminated. Revisit
    // before any mainnet deployment.
    let keeper_share_estimate = if is_rescue {
        Some(split_share(
            ctx.accounts.escrow.gas_buffer_lamports,
            KEEPER_SHARE_BPS,
        )?)
    } else {
        None
    };

    if is_rescue {
        let slots_into_rescue = elapsed.saturating_sub(ctx.accounts.escrow.ttl_slots);
        let required_tip = anti_snipe_required_tip(
            keeper_share_estimate.unwrap_or(MIN_JITO_TIP_LAMPORTS),
            slots_into_rescue,
        );
        require!(
            jito_tip_at_least(
                &ctx.accounts.instructions_sysvar.to_account_info(),
                required_tip
            )?,
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
        // invoke_signed looks up the target program in this slice, not just
        // in the instruction's own AccountMeta list -- omitting it produces
        // "Unsupported program id" even though the account isn't referenced
        // by the instruction's account metas at all.
        ctx.accounts.swap_program.to_account_info(),
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
/// Instructions sysvar can't see those) for a System Program transfer of at
/// least `required_amount` to one of the known Jito tip accounts.
///
/// This cannot, and does not claim to, prove the transaction was actually
/// routed through Jito's private bundle infrastructure rather than the
/// public mempool -- that's a network-routing property no on-chain check can
/// see. Checking a real amount (not just presence) only closes the cheapest
/// version of gaming this: satisfying the check with a 1-lamport transfer
/// that costs nothing and proves nothing. `required_amount` is computed
/// per-call by `anti_snipe_required_tip`, not a flat constant.
fn jito_tip_at_least(instructions_sysvar: &AccountInfo, required_amount: u64) -> Result<bool> {
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
            && transfer_amount(&ix.data) >= required_amount
        {
            return Ok(true);
        }
        index += 1;
    }
}

/// The anti-snipe required-tip curve: starts at `keeper_share` (the reward
/// itself) at the earliest rescue-eligible slot -- so claiming the reward
/// costs at least as much as it pays, making pure profit-seeking sniping
/// break-even-or-negative -- and decays linearly down to
/// MIN_JITO_TIP_LAMPORTS over TIP_DECAY_SLOTS, after which the normal floor
/// applies. `slots_into_rescue` is 1 at the first slot where is_rescue is
/// true (elapsed == ttl_slots + 1), matching decay_progress == 0 below.
fn anti_snipe_required_tip(keeper_share: u64, slots_into_rescue: u64) -> u64 {
    let decay_progress = slots_into_rescue.saturating_sub(1);
    if keeper_share <= MIN_JITO_TIP_LAMPORTS || decay_progress >= TIP_DECAY_SLOTS {
        return MIN_JITO_TIP_LAMPORTS;
    }
    let remaining_slots = TIP_DECAY_SLOTS - decay_progress;
    let extra_above_floor = keeper_share - MIN_JITO_TIP_LAMPORTS;
    MIN_JITO_TIP_LAMPORTS
        + extra_above_floor.saturating_mul(remaining_slots) / TIP_DECAY_SLOTS
}

/// Parses lamports out of a System Program Transfer instruction's data:
/// 4-byte LE discriminator (2 = Transfer) followed by an 8-byte LE amount.
/// Returns 0 for anything that doesn't match that exact shape, which just
/// means it fails the minimum-amount check rather than passing on garbage.
fn transfer_amount(data: &[u8]) -> u64 {
    if data.len() < 12 || data[0..4] != [2, 0, 0, 0] {
        return 0;
    }
    u64::from_le_bytes(data[4..12].try_into().unwrap_or_default())
}
