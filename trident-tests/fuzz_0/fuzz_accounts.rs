use trident_fuzz::fuzzing::*;

/// Storage for all account addresses used in fuzz testing.
///
/// This struct serves as a centralized repository for account addresses,
/// enabling their reuse across different instruction flows and test scenarios.
///
/// Docs: https://ackee.xyz/trident/docs/latest/trident-api-macro/trident-types/fuzz-accounts/
#[derive(Default)]
pub struct AccountAddresses {
    pub caller: AddressStorage,

    pub escrow: AddressStorage,

    pub user_wallet: AddressStorage,

    pub partner_wallet: AddressStorage,

    pub treasury: AddressStorage,

    pub user_input_token_account: AddressStorage,

    pub destination_token_account: AddressStorage,

    pub swap_program: AddressStorage,

    pub token_program: AddressStorage,

    pub instructions_sysvar: AddressStorage,

    pub expected_destination_token_account: AddressStorage,

    pub system_program: AddressStorage,

    pub contributor: AddressStorage,

    pub source: AddressStorage,

    pub destination: AddressStorage,

    pub authority: AddressStorage,

    pub source_mint: AddressStorage,

    pub output_mint: AddressStorage,

    pub mint_authority: AddressStorage,

    pub mint: AddressStorage,

    pub dest_mint: AddressStorage,

    pub dest_token_account: AddressStorage,

    pub impostor: AddressStorage,

    pub cleanup_caller: AddressStorage,
}
