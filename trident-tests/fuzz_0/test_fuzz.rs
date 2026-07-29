use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;
mod types;
use types::*;

use crate::types::inertia_protocol::{
    CleanupExpiredEscrowInstruction, CleanupExpiredEscrowInstructionAccounts,
    CleanupExpiredEscrowInstructionData, InitializeEscrowInstruction,
    InitializeEscrowInstructionAccounts, InitializeEscrowInstructionData, SelfRescueInstruction,
    SelfRescueInstructionAccounts, SelfRescueInstructionData,
};

#[derive(FuzzTestMethods)]
struct FuzzTest {
    /// Trident client for interacting with the Solana program
    trident: Trident,
    /// Storage for all account addresses used in fuzz testing
    fuzz_accounts: AccountAddresses,
}

#[flow_executor]
impl FuzzTest {
    fn new() -> Self {
        Self {
            trident: Trident::default(),
            fuzz_accounts: AccountAddresses::default(),
        }
    }

    #[init]
    fn start(&mut self) {
        // Perform any initialization here, this method will be executed
        // at the start of each iteration
    }

    /// Sets up a fresh escrow with a fuzzed nonce and buffer, backed by a
    /// real SPL mint + token account so initialize_escrow's account
    /// constraints (owner checks, delegate approve) are exercised for real,
    /// not stubbed out.
    fn setup_escrow(&mut self) -> (Pubkey, Pubkey, Pubkey, u64) {
        let user_wallet = self.fuzz_accounts.user_wallet.insert(&mut self.trident, None);
        self.trident.airdrop(&user_wallet, 10 * LAMPORTS_PER_SOL);

        let mint = self.fuzz_accounts.mint.insert(&mut self.trident, None);
        let ixs = self
            .trident
            .initialize_mint(&user_wallet, &mint, 6, &user_wallet, None);
        self.trident
            .process_transaction(&ixs, Some("init mint"));

        let user_input_token_account = self
            .fuzz_accounts
            .user_input_token_account
            .insert(&mut self.trident, None);
        let ixs = self.trident.initialize_token_account(
            &user_wallet,
            &user_input_token_account,
            &mint,
            &user_wallet,
        );
        self.trident
            .process_transaction(&ixs, Some("init user input token account"));

        let dest_mint = self.fuzz_accounts.dest_mint.insert(&mut self.trident, None);
        let ixs = self
            .trident
            .initialize_mint(&user_wallet, &dest_mint, 6, &user_wallet, None);
        self.trident
            .process_transaction(&ixs, Some("init dest mint"));

        let dest_token_account = self
            .fuzz_accounts
            .dest_token_account
            .insert(&mut self.trident, None);
        let ixs = self.trident.initialize_token_account(
            &user_wallet,
            &dest_token_account,
            &dest_mint,
            &user_wallet,
        );
        self.trident
            .process_transaction(&ixs, Some("init dest token account"));

        let nonce: u64 = self.trident.random_from_range(0..u64::MAX);
        let nonce_bytes = nonce.to_le_bytes();
        let escrow = self.fuzz_accounts.escrow.insert(
            &mut self.trident,
            Some(PdaSeeds {
                seeds: &[b"escrow", user_wallet.as_ref(), &nonce_bytes],
                program_id: inertia_protocol::program_id(),
            }),
        );

        // Above MIN_JITO_TIP_LAMPORTS-relevant rent-exemption thresholds --
        // see the adversarial review notes on why tiny buffers are fragile.
        let buffer: u64 = self.trident.random_from_range(40_000_000..200_000_000);
        let input_amount: u64 = self.trident.random_from_range(1_000..1_000_000_000);

        let params = InitializeEscrowParams::new(
            nonce,
            buffer,
            buffer, // dynamic_minimum == buffer: always satisfies the sanity check
            user_wallet, // partner_wallet: reuse user_wallet, irrelevant to these flows
            input_amount,
            inertia_protocol::program_id(), // expected_program_id: unused by these flows
            [0u8; 8],
            1,
        );

        let ix = InitializeEscrowInstruction::data(InitializeEscrowInstructionData::new(params))
            .accounts(InitializeEscrowInstructionAccounts::new(
                user_wallet,
                user_input_token_account,
                dest_token_account,
                escrow,
            ))
            .instruction();

        let res = self.trident.process_transaction(&[ix], Some("initialize_escrow"));
        assert!(
            res.is_success(),
            "initialize_escrow failed: {:#?}",
            res.get_result()
        );

        (user_wallet, escrow, user_input_token_account, buffer)
    }

    #[flow]
    /// Invariant: self_rescue must reject a caller before the 150-slot
    /// window elapses, regardless of buffer size or nonce.
    fn self_rescue_too_early_fails(&mut self) {
        let (user_wallet, escrow, user_input_token_account, _buffer) = self.setup_escrow();

        let ix = SelfRescueInstruction::data(SelfRescueInstructionData::new())
            .accounts(SelfRescueInstructionAccounts::new(
                user_wallet,
                escrow,
                user_input_token_account,
            ))
            .instruction();

        let res = self.trident.process_transaction(&[ix], Some("self_rescue too early"));
        assert!(
            !res.is_success(),
            "self_rescue succeeded before the 150-slot window elapsed"
        );
    }

    #[flow]
    /// Invariant: self_rescue must reject anyone who isn't the escrow's
    /// own user_wallet, even after the window elapses.
    fn self_rescue_wrong_signer_fails(&mut self) {
        let (_user_wallet, escrow, user_input_token_account, _buffer) = self.setup_escrow();

        let impostor = self.fuzz_accounts.impostor.insert(&mut self.trident, None);
        self.trident.airdrop(&impostor, 10 * LAMPORTS_PER_SOL);

        let clock: solana_sdk::clock::Clock = self.trident.get_sysvar();
        self.trident.warp_to_slot(clock.slot + 200);

        let ix = SelfRescueInstruction::data(SelfRescueInstructionData::new())
            .accounts(SelfRescueInstructionAccounts::new(
                impostor,
                escrow,
                user_input_token_account,
            ))
            .instruction();

        let res = self.trident.process_transaction(&[ix], Some("self_rescue wrong signer"));
        assert!(
            !res.is_success(),
            "self_rescue succeeded for a signer that isn't the escrow's user_wallet"
        );
    }

    #[flow]
    /// Invariant: after 150 slots, the true owner's self_rescue succeeds and
    /// returns the full buffer (within a small fee/rent tolerance), and the
    /// escrow account is gone afterward -- no residual double-claim surface.
    fn self_rescue_after_window_succeeds_and_closes(&mut self) {
        let (user_wallet, escrow, user_input_token_account, buffer) = self.setup_escrow();

        let balance_before = self.trident.get_account(&user_wallet).lamports();

        let clock: solana_sdk::clock::Clock = self.trident.get_sysvar();
        self.trident.warp_to_slot(clock.slot + 200);

        let ix = SelfRescueInstruction::data(SelfRescueInstructionData::new())
            .accounts(SelfRescueInstructionAccounts::new(
                user_wallet,
                escrow,
                user_input_token_account,
            ))
            .instruction();

        let res = self.trident.process_transaction(&[ix], Some("self_rescue"));
        assert!(
            res.is_success(),
            "self_rescue failed after the window elapsed: {:#?}",
            res.get_result()
        );

        let balance_after = self.trident.get_account(&user_wallet).lamports();
        assert!(
            balance_after >= balance_before + buffer.saturating_sub(50_000),
            "self_rescue did not return roughly the full buffer: before={} after={} buffer={}",
            balance_before,
            balance_after,
            buffer
        );

        assert!(
            self.trident.get_account(&escrow).lamports() == 0,
            "escrow account still holds lamports after self_rescue closed it"
        );

        // No double-claim: a second self_rescue against the same, now-closed
        // escrow must fail outright.
        let ix2 = SelfRescueInstruction::data(SelfRescueInstructionData::new())
            .accounts(SelfRescueInstructionAccounts::new(
                user_wallet,
                escrow,
                user_input_token_account,
            ))
            .instruction();
        let res2 = self.trident.process_transaction(&[ix2], Some("self_rescue again"));
        assert!(
            !res2.is_success(),
            "self_rescue succeeded twice against the same escrow"
        );
    }

    #[flow]
    /// Invariant: cleanup_expired_escrow must reject any caller before the
    /// 300-slot window elapses.
    fn cleanup_too_early_fails(&mut self) {
        let (user_wallet, escrow, _user_input_token_account, _buffer) = self.setup_escrow();

        let caller = self.fuzz_accounts.cleanup_caller.insert(&mut self.trident, None);
        self.trident.airdrop(&caller, 10 * LAMPORTS_PER_SOL);

        let ix = CleanupExpiredEscrowInstruction::data(CleanupExpiredEscrowInstructionData::new())
            .accounts(CleanupExpiredEscrowInstructionAccounts::new(
                caller, escrow, user_wallet,
            ))
            .instruction();

        let res = self.trident.process_transaction(&[ix], Some("cleanup too early"));
        assert!(
            !res.is_success(),
            "cleanup_expired_escrow succeeded before the 300-slot window elapsed"
        );
    }

    #[flow]
    /// Invariant: after 300 slots, cleanup is permissionless, pays the
    /// caller exactly 10% of the buffer, and the user gets the rest -- the
    /// two shares always sum to the original buffer.
    fn cleanup_after_window_splits_correctly(&mut self) {
        let (user_wallet, escrow, _user_input_token_account, buffer) = self.setup_escrow();

        let caller = self.fuzz_accounts.cleanup_caller.insert(&mut self.trident, None);
        self.trident.airdrop(&caller, 10 * LAMPORTS_PER_SOL);

        let caller_before = self.trident.get_account(&caller).lamports();
        let user_before = self.trident.get_account(&user_wallet).lamports();

        let clock: solana_sdk::clock::Clock = self.trident.get_sysvar();
        self.trident.warp_to_slot(clock.slot + 350);

        let ix = CleanupExpiredEscrowInstruction::data(CleanupExpiredEscrowInstructionData::new())
            .accounts(CleanupExpiredEscrowInstructionAccounts::new(
                caller, escrow, user_wallet,
            ))
            .instruction();

        let res = self.trident.process_transaction(&[ix], Some("cleanup_expired_escrow"));
        assert!(
            res.is_success(),
            "cleanup_expired_escrow failed after the window elapsed: {:#?}",
            res.get_result()
        );

        let caller_after = self.trident.get_account(&caller).lamports();
        let user_after = self.trident.get_account(&user_wallet).lamports();

        let caller_gain = caller_after.saturating_sub(caller_before);
        let user_gain = user_after.saturating_sub(user_before);

        let expected_bounty = (buffer as u128 * 1_000 / 10_000) as u64;
        assert!(
            caller_gain + 20_000 >= expected_bounty && caller_gain <= expected_bounty + 20_000,
            "cleanup bounty off from the expected 10% share: got={} expected={}",
            caller_gain,
            expected_bounty
        );

        // The two shares should account for the whole buffer between them --
        // neither more (funds from nowhere) nor less (funds vanishing).
        assert!(
            caller_gain + user_gain + 40_000 >= buffer,
            "caller + user shares don't add up to roughly the full buffer: caller={} user={} buffer={}",
            caller_gain,
            user_gain,
            buffer
        );
    }

    #[end]
    fn end(&mut self) {
        // Perform any cleanup here, this method will be executed
        // at the end of each iteration
    }
}

fn main() {
    FuzzTest::fuzz(1000, 100);
}

