use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod state;

use state::*;

declare_id!("8ST3LRU5gv8ijZehvXdwRzc6VnvqbVozCCdFzEzqhqbW");

#[program]
pub mod inertia_protocol {
    use super::*;
}
