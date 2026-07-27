use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct EscrowState {
    /// Original trader. Only this key may call `self_rescue`, and it is the
    /// mandatory destination for swap output (see V6, wrapper contract exploit).
    pub user_wallet: Pubkey,
    /// Integration partner's treasury. Receives 5% of the buffer when a swap
    /// is executed after the TTL (a genuine keeper rescue).
    pub partner_wallet: Pubkey,

    /// User's own token account holding the trade input. Never moved out of
    /// user custody directly -- the escrow only ever holds delegated spending
    /// authority over it (SPL Token `approve`), revocable independently of
    /// this program at any time via a plain `revoke` instruction.
    pub user_input_token_account: Pubkey,
    /// Amount delegated and expected to be swapped.
    pub input_amount: u64,

    /// Program ID the swap CPI must be executed against.
    pub expected_program_id: Pubkey,
    /// Anchor 8-byte instruction discriminator identifying which instruction
    /// on `expected_program_id` to invoke.
    pub expected_discriminator: [u8; 8],
    /// The token account that must receive swap output -- the canonical ATA
    /// for (user_wallet, output_mint), computed off-chain and fixed at init.
    pub expected_destination_token_account: Pubkey,
    /// Minimum acceptable output amount (slippage floor). The swap CPI's
    /// result is checked against this before any funds are released.
    pub expected_output_amount: u64,

    /// Lamports held as bounty/refund buffer (separate from the account's
    /// rent-exempt reserve).
    pub gas_buffer_lamports: u64,
    pub creation_slot: u64,
    /// Hardcoded to TTL_SLOTS at init; stored for on-chain readability of the
    /// liveness check rather than re-reading the constant.
    pub ttl_slots: u64,
    /// Client-generated value used only to make the PDA unique per (user,
    /// escrow). Not a signature -- see build log for why original_tx_signature
    /// can't be used as a seed or stored as a field.
    pub nonce: u64,

    pub status: EscrowStatus,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    Pending,
    /// Swap executed via this program's CPI, before or after TTL.
    Executed,
    Rescued,
    Expired,
}
