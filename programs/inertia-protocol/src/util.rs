use anchor_lang::prelude::*;

use crate::constants::BASIS_POINTS_DIVISOR;
use crate::errors::InertiaError;

pub fn split_share(total: u64, share_bps: u128) -> Result<u64> {
    u64::try_from((total as u128) * share_bps / BASIS_POINTS_DIVISOR)
        .map_err(|_| InertiaError::Overflow.into())
}

/// Direct lamport debit/credit -- the only valid way to move lamports out of
/// a program-owned account (a CPI transfer requires the source to be owned
/// by the System Program, which escrow PDAs are not).
pub fn move_lamports<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    **from.try_borrow_mut_lamports()? = from
        .lamports()
        .checked_sub(amount)
        .ok_or(InertiaError::Overflow)?;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(amount)
        .ok_or(InertiaError::Overflow)?;
    Ok(())
}
