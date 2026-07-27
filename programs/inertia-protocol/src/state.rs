use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct EscrowState {
    /// Original trader. Only this key may call `self_rescue`, and it is the
    /// mandatory destination for the swap this escrow guards (see V6, wrapper
    /// contract exploit).
    pub user_wallet: Pubkey,
    /// Integration partner's treasury. Receives 5% of the buffer on acceleration.
    /// Set once at init from the calling SDK's configured partner address.
    pub partner_wallet: Pubkey,

    /// Program ID the rescued swap instruction must belong to.
    pub expected_program_id: Pubkey,
    /// Anchor 8-byte instruction discriminator the swap instruction must carry.
    /// Assumes the target DEX/router uses Anchor's sighash discriminator
    /// convention; non-Anchor programs would need a different comparison.
    pub expected_discriminator: [u8; 8],
    /// The token account that must receive swap output — the canonical ATA for
    /// (user_wallet, output_mint), computed off-chain and fixed at init. Compared
    /// directly against the swap instruction's destination account key.
    pub expected_destination_token_account: Pubkey,
    /// Expected output amount, stored for off-chain audit/display. Not enforced
    /// on-chain: parsing amount out of arbitrary instruction data generically
    /// across DEXes is unreliable, so the security-critical checks are
    /// program id + discriminator + destination account (see V5, V6).
    pub expected_amount: u64,

    /// Lamports currently held as bounty/refund buffer (separate from the
    /// account's rent-exempt reserve).
    pub gas_buffer_lamports: u64,
    pub creation_slot: u64,
    /// Hardcoded to TTL_SLOTS at init; stored for on-chain readability of the
    /// liveness check rather than re-reading the constant.
    pub ttl_slots: u64,
    /// Client-generated value used only to make the PDA unique per (user,
    /// escrow). Not a signature — see build log for why original_tx_signature
    /// can't be used as a seed or stored as a field.
    pub nonce: u64,

    pub status: EscrowStatus,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum EscrowStatus {
    Pending,
    Accelerated,
    Rescued,
    Expired,
}
