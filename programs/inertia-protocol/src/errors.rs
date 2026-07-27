use anchor_lang::prelude::*;

#[error_code]
pub enum InertiaError {
    #[msg("Gas buffer is below the dynamic minimum required")]
    BufferBelowMinimum,
    #[msg("Escrow is not in Pending status")]
    NotPending,
    #[msg("TTL has not yet elapsed")]
    TtlNotElapsed,
    #[msg("Self-rescue window has not yet elapsed")]
    SelfRescueWindowNotElapsed,
    #[msg("Cleanup window has not yet elapsed")]
    CleanupWindowNotElapsed,
    #[msg("Jito tip instruction not found in transaction")]
    MissingJitoTip,
    #[msg("Expected swap instruction not found in transaction")]
    MissingSwapInstruction,
    #[msg("Swap instruction destination account does not match escrow record")]
    SwapDestinationMismatch,
    #[msg("Signer does not match the keeper wallet submitting acceleration")]
    KeeperSignerMismatch,
    #[msg("Only the original user wallet may call this instruction")]
    UnauthorizedUser,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Fee split does not sum to total buffer")]
    FeeSplitMismatch,
    #[msg("Supplied swap instruction data is missing or has the wrong discriminator")]
    InvalidSwapInstructionData,
    #[msg("Swap output was below the escrow's minimum acceptable amount")]
    OutputBelowMinimum,
}
