use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;
pub mod util;

use instructions::*;

declare_id!("8ST3LRU5gv8ijZehvXdwRzc6VnvqbVozCCdFzEzqhqbW");

#[program]
pub mod inertia_protocol {
    use super::*;

    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        params: InitializeEscrowParams,
    ) -> Result<()> {
        instructions::initialize_escrow::handler(ctx, params)
    }

    pub fn execute_swap<'info>(
        ctx: Context<'info, ExecuteSwap<'info>>,
        swap_instruction_data: Vec<u8>,
    ) -> Result<()> {
        instructions::execute_swap::handler(ctx, swap_instruction_data)
    }

    pub fn self_rescue(ctx: Context<SelfRescue>) -> Result<()> {
        instructions::self_rescue::handler(ctx)
    }

    pub fn cleanup_expired_escrow(ctx: Context<CleanupExpiredEscrow>) -> Result<()> {
        instructions::cleanup_expired_escrow::handler(ctx)
    }

    pub fn top_up_buffer(ctx: Context<TopUpBuffer>, amount: u64) -> Result<()> {
        instructions::top_up_buffer::handler(ctx, amount)
    }
}
