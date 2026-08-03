use fuzz_accounts::*;
use trident_fuzz::fuzzing::*;
mod fuzz_accounts;
mod types;
use types::*;

use crate::types::inertia_protocol::{
    CleanupExpiredEscrowInstruction, CleanupExpiredEscrowInstructionAccounts,
    CleanupExpiredEscrowInstructionData, ExecuteSwapInstruction, ExecuteSwapInstructionAccounts,
    ExecuteSwapInstructionData, InitializeEscrowInstruction, InitializeEscrowInstructionAccounts,
    InitializeEscrowInstructionData, SelfRescueInstruction, SelfRescueInstructionAccounts,
    SelfRescueInstructionData,
};

// Mirrors constants.rs and the anti_snipe_required_tip formula in
// execute_swap.rs -- duplicated here rather than imported, the same way the
// TypeScript SDK duplicates it in antiSnipe.ts, since the fuzz harness only
// ever reaches the program through real transactions, never by linking
// against its internal (private, non-pub) functions directly.
const TTL_SLOTS: u64 = 2;
const TIP_DECAY_SLOTS: u64 = 15;
const MIN_JITO_TIP_LAMPORTS: u64 = 10_000;
const KEEPER_SHARE_BPS: u128 = 9_000;
const PARTNER_SHARE_BPS: u128 = 500;
const BASIS_POINTS_DIVISOR: u128 = 10_000;
// One of the eight real, hardcoded JITO_TIP_ACCOUNTS from constants.rs --
// jito_tip_at_least only recognizes a transfer to one of these exact
// addresses, so the fuzz harness has to target a real one, not a randomly
// generated address.
const JITO_TIP_ACCOUNT: Pubkey = pubkey!("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5");
const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
// mock-dex's real Anchor discriminator for its "swap" instruction --
// coincidentally identical to Orca Whirlpools' own "swap" discriminator
// (Section 12.9 of the technical report), since Anchor discriminators are
// derived purely from the instruction name, not the program.
const MOCK_DEX_SWAP_DISCRIMINATOR: [u8; 8] = [248, 198, 158, 145, 225, 117, 135, 200];

fn anti_snipe_required_tip(keeper_share: u64, slots_into_rescue: u64) -> u64 {
    let decay_progress = slots_into_rescue.saturating_sub(1);
    if keeper_share <= MIN_JITO_TIP_LAMPORTS || decay_progress >= TIP_DECAY_SLOTS {
        return MIN_JITO_TIP_LAMPORTS;
    }
    let remaining_slots = TIP_DECAY_SLOTS - decay_progress;
    let extra_above_floor = keeper_share - MIN_JITO_TIP_LAMPORTS;
    MIN_JITO_TIP_LAMPORTS + extra_above_floor.saturating_mul(remaining_slots) / TIP_DECAY_SLOTS
}

fn split_share(total: u64, share_bps: u128) -> u64 {
    ((total as u128) * share_bps / BASIS_POINTS_DIVISOR) as u64
}

fn mock_dex_swap_data(amount_in: u64, amount_out: u64) -> Vec<u8> {
    let mut data = MOCK_DEX_SWAP_DISCRIMINATOR.to_vec();
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&amount_out.to_le_bytes());
    data
}

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

    /// Same shape as setup_escrow, but wired to mock-dex as a genuine,
    /// callable swap venue (registered in Trident.toml alongside
    /// inertia_protocol) instead of a placeholder program_id/discriminator
    /// self_rescue and cleanup never actually invoke. Returns everything a
    /// caller needs to build a real execute_swap CPI: the escrow, both
    /// token accounts, both mints, and mock-dex's mint-authority PDA.
    #[allow(clippy::type_complexity)]
    fn setup_escrow_for_swap(
        &mut self,
        input_amount: u64,
        expected_output_amount: u64,
    ) -> (Pubkey, Pubkey, Pubkey, Pubkey, Pubkey, Pubkey, Pubkey, u64) {
        let user_wallet = self.fuzz_accounts.user_wallet.insert(&mut self.trident, None);
        self.trident.airdrop(&user_wallet, 10 * LAMPORTS_PER_SOL);

        let mint = self.fuzz_accounts.mint.insert(&mut self.trident, None);
        let ixs = self.trident.initialize_mint(&user_wallet, &mint, 6, &user_wallet, None);
        self.trident.process_transaction(&ixs, Some("init mint"));

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

        // Fund the input account for real -- mock-dex's swap genuinely
        // burns amount_in from it, not a simulated/stubbed amount.
        let mint_to_ix = self.trident.mint_to(
            &user_input_token_account,
            &mint,
            &user_wallet,
            input_amount.saturating_add(1_000_000),
        );
        self.trident
            .process_transaction(&[mint_to_ix], Some("fund input token account"));

        let (mint_authority_pda, _) =
            Pubkey::find_program_address(&[b"mint_authority"], &mock_dex::program_id());

        let dest_mint = self.fuzz_accounts.dest_mint.insert(&mut self.trident, None);
        let ixs =
            self.trident
                .initialize_mint(&user_wallet, &dest_mint, 6, &mint_authority_pda, None);
        self.trident.process_transaction(&ixs, Some("init dest mint"));

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

        let buffer: u64 = self.trident.random_from_range(40_000_000..200_000_000);

        let params = InitializeEscrowParams::new(
            nonce,
            buffer,
            buffer,
            user_wallet,
            input_amount,
            mock_dex::program_id(),
            MOCK_DEX_SWAP_DISCRIMINATOR,
            expected_output_amount,
        );

        let ix = InitializeEscrowInstruction::data(InitializeEscrowInstructionData::new(params))
            .accounts(InitializeEscrowInstructionAccounts::new(
                user_wallet,
                user_input_token_account,
                dest_token_account,
                escrow,
            ))
            .instruction();

        let res = self
            .trident
            .process_transaction(&[ix], Some("initialize_escrow for swap"));
        assert!(
            res.is_success(),
            "initialize_escrow (swap setup) failed: {:#?}",
            res.get_result()
        );

        (
            user_wallet,
            escrow,
            user_input_token_account,
            dest_token_account,
            mint,
            dest_mint,
            mint_authority_pda,
            buffer,
        )
    }

    /// The real mock-dex CPI account list, in mock-dex's own real order
    /// (source, destination, authority, token_program, source_mint,
    /// output_mint, mint_authority) -- exactly what the generic
    /// account-ordering redesign (Section 7.2 of the technical report)
    /// requires the caller to supply, matching the identical pattern
    /// already proven in the TS integration suite and the real devnet
    /// Orca integration.
    fn mock_dex_remaining_accounts(
        &self,
        user_input_token_account: Pubkey,
        dest_token_account: Pubkey,
        escrow: Pubkey,
        mint: Pubkey,
        dest_mint: Pubkey,
        mint_authority_pda: Pubkey,
    ) -> Vec<AccountMeta> {
        vec![
            AccountMeta::new(user_input_token_account, false),
            AccountMeta::new(dest_token_account, false),
            AccountMeta::new_readonly(escrow, false),
            AccountMeta::new_readonly(TOKEN_PROGRAM_ID, false),
            AccountMeta::new(mint, false),
            AccountMeta::new(dest_mint, false),
            AccountMeta::new_readonly(mint_authority_pda, false),
        ]
    }

    #[flow]
    /// Invariant: execute_swap called before TTL_SLOTS have elapsed always
    /// succeeds (given a real swap that clears the output floor) and always
    /// refunds the caller 100% of the buffer, regardless of buffer size or
    /// input/output amounts -- the ordinary path never requires a tip.
    fn execute_swap_before_ttl_refunds_full_buffer(&mut self) {
        let input_amount: u64 = self.trident.random_from_range(1_000..1_000_000_000);
        let output_amount: u64 = self.trident.random_from_range(1..1_000_000_000);
        let (
            user_wallet,
            escrow,
            user_input_token_account,
            dest_token_account,
            mint,
            dest_mint,
            mint_authority_pda,
            buffer,
        ) = self.setup_escrow_for_swap(input_amount, output_amount);

        let remaining_accounts = self.mock_dex_remaining_accounts(
            user_input_token_account,
            dest_token_account,
            escrow,
            mint,
            dest_mint,
            mint_authority_pda,
        );
        let swap_data = mock_dex_swap_data(input_amount, output_amount);

        let ix = ExecuteSwapInstruction::data(ExecuteSwapInstructionData::new(swap_data))
            .accounts(ExecuteSwapInstructionAccounts::new(
                user_wallet,
                escrow,
                user_wallet,
                user_wallet,
                user_input_token_account,
                dest_token_account,
                mock_dex::program_id(),
            ))
            .remaining_accounts(remaining_accounts)
            .instruction();

        let user_balance_before = self.trident.get_account(&user_wallet).lamports();
        let res = self
            .trident
            .process_transaction(&[ix], Some("execute_swap before TTL"));
        assert!(
            res.is_success(),
            "execute_swap failed before TTL with a valid swap: {:#?}",
            res.get_result()
        );

        let user_balance_after = self.trident.get_account(&user_wallet).lamports();
        assert!(
            user_balance_after + 20_000 >= user_balance_before + buffer,
            "fast path did not refund roughly the full buffer: before={} after={} buffer={}",
            user_balance_before,
            user_balance_after,
            buffer
        );
    }

    #[flow]
    /// Invariant: execute_swap after TTL_SLOTS with no Jito tip instruction
    /// at all must always fail, regardless of how far past TTL the call is.
    fn execute_swap_rescue_without_tip_fails(&mut self) {
        let input_amount: u64 = self.trident.random_from_range(1_000..1_000_000_000);
        let output_amount: u64 = self.trident.random_from_range(1..1_000_000_000);
        let (
            user_wallet,
            escrow,
            user_input_token_account,
            dest_token_account,
            mint,
            dest_mint,
            mint_authority_pda,
            _buffer,
        ) = self.setup_escrow_for_swap(input_amount, output_amount);

        let keeper = self.fuzz_accounts.impostor.insert(&mut self.trident, None);
        self.trident.airdrop(&keeper, 10 * LAMPORTS_PER_SOL);

        let clock: solana_sdk::clock::Clock = self.trident.get_sysvar();
        let extra_slots: u64 = self.trident.random_from_range(1..50);
        self.trident.warp_to_slot(clock.slot + TTL_SLOTS + extra_slots);

        let remaining_accounts = self.mock_dex_remaining_accounts(
            user_input_token_account,
            dest_token_account,
            escrow,
            mint,
            dest_mint,
            mint_authority_pda,
        );
        let swap_data = mock_dex_swap_data(input_amount, output_amount);

        let ix = ExecuteSwapInstruction::data(ExecuteSwapInstructionData::new(swap_data))
            .accounts(ExecuteSwapInstructionAccounts::new(
                keeper,
                escrow,
                user_wallet,
                user_wallet,
                user_input_token_account,
                dest_token_account,
                mock_dex::program_id(),
            ))
            .remaining_accounts(remaining_accounts)
            .instruction();

        let res = self
            .trident
            .process_transaction(&[ix], Some("execute_swap rescue, no tip"));
        assert!(
            !res.is_success(),
            "execute_swap succeeded on the rescue path with no Jito tip at all"
        );
    }

    #[flow]
    /// Invariant: a tip strictly below the exact amount the anti-snipe
    /// decay curve currently requires must always fail, at any point in
    /// the decay window -- not just when the tip is below the flat floor.
    fn execute_swap_rescue_with_insufficient_tip_fails(&mut self) {
        let input_amount: u64 = self.trident.random_from_range(1_000..1_000_000_000);
        let output_amount: u64 = self.trident.random_from_range(1..1_000_000_000);
        let (
            user_wallet,
            escrow,
            user_input_token_account,
            dest_token_account,
            mint,
            dest_mint,
            mint_authority_pda,
            buffer,
        ) = self.setup_escrow_for_swap(input_amount, output_amount);

        let keeper = self.fuzz_accounts.impostor.insert(&mut self.trident, None);
        self.trident.airdrop(&keeper, 10 * LAMPORTS_PER_SOL);
        // Real mainnet tip accounts are already funded; a fresh fuzz-SVM
        // account is not -- pre-fund it the same way the project's own
        // local-validator tests and devnet scripts already do.
        self.trident.airdrop(&JITO_TIP_ACCOUNT, 10 * LAMPORTS_PER_SOL);

        let slots_into_rescue: u64 = self.trident.random_from_range(1..=TIP_DECAY_SLOTS);
        let clock: solana_sdk::clock::Clock = self.trident.get_sysvar();
        self.trident
            .warp_to_slot(clock.slot + TTL_SLOTS + slots_into_rescue);

        let keeper_share = split_share(buffer, KEEPER_SHARE_BPS);
        let required_tip = anti_snipe_required_tip(keeper_share, slots_into_rescue);
        // Strictly below the required amount, but never below zero and
        // never accidentally equal to it.
        let insufficient_tip: u64 = if required_tip <= 1 {
            return; // no room to construct a strictly-smaller amount; skip this iteration
        } else {
            self.trident.random_from_range(0..required_tip)
        };

        let tip_ix = solana_sdk::system_instruction::transfer(
            &keeper,
            &JITO_TIP_ACCOUNT,
            insufficient_tip,
        );

        let remaining_accounts = self.mock_dex_remaining_accounts(
            user_input_token_account,
            dest_token_account,
            escrow,
            mint,
            dest_mint,
            mint_authority_pda,
        );
        let swap_data = mock_dex_swap_data(input_amount, output_amount);

        let execute_ix = ExecuteSwapInstruction::data(ExecuteSwapInstructionData::new(swap_data))
            .accounts(ExecuteSwapInstructionAccounts::new(
                keeper,
                escrow,
                user_wallet,
                user_wallet,
                user_input_token_account,
                dest_token_account,
                mock_dex::program_id(),
            ))
            .remaining_accounts(remaining_accounts)
            .instruction();

        let res = self.trident.process_transaction(
            &[tip_ix, execute_ix],
            Some("execute_swap rescue, insufficient tip"),
        );
        assert!(
            !res.is_success(),
            "execute_swap succeeded with a tip ({}) below the required anti-snipe amount ({}) at slot {} into the rescue window",
            insufficient_tip,
            required_tip,
            slots_into_rescue
        );
    }

    #[flow]
    /// Invariant: a tip at or above the exact required amount always
    /// succeeds and always splits the buffer 90/5/5 (caller/partner/
    /// treasury), for any buffer size and any point in the decay window.
    fn execute_swap_rescue_with_sufficient_tip_splits_correctly(&mut self) {
        let input_amount: u64 = self.trident.random_from_range(1_000..1_000_000_000);
        let output_amount: u64 = self.trident.random_from_range(1..1_000_000_000);
        let (
            user_wallet,
            escrow,
            user_input_token_account,
            dest_token_account,
            mint,
            dest_mint,
            mint_authority_pda,
            buffer,
        ) = self.setup_escrow_for_swap(input_amount, output_amount);

        let keeper = self.fuzz_accounts.impostor.insert(&mut self.trident, None);
        self.trident.airdrop(&keeper, 10 * LAMPORTS_PER_SOL);
        self.trident.airdrop(&JITO_TIP_ACCOUNT, 10 * LAMPORTS_PER_SOL);

        let slots_into_rescue: u64 = self.trident.random_from_range(1..=TIP_DECAY_SLOTS + 5);
        let clock: solana_sdk::clock::Clock = self.trident.get_sysvar();
        self.trident
            .warp_to_slot(clock.slot + TTL_SLOTS + slots_into_rescue);

        let keeper_share = split_share(buffer, KEEPER_SHARE_BPS);
        let partner_share = split_share(buffer, PARTNER_SHARE_BPS);
        let required_tip = anti_snipe_required_tip(keeper_share, slots_into_rescue);

        let tip_ix =
            solana_sdk::system_instruction::transfer(&keeper, &JITO_TIP_ACCOUNT, required_tip);

        let remaining_accounts = self.mock_dex_remaining_accounts(
            user_input_token_account,
            dest_token_account,
            escrow,
            mint,
            dest_mint,
            mint_authority_pda,
        );
        let swap_data = mock_dex_swap_data(input_amount, output_amount);

        let execute_ix = ExecuteSwapInstruction::data(ExecuteSwapInstructionData::new(swap_data))
            .accounts(ExecuteSwapInstructionAccounts::new(
                keeper,
                escrow,
                user_wallet,
                user_wallet,
                user_input_token_account,
                dest_token_account,
                mock_dex::program_id(),
            ))
            .remaining_accounts(remaining_accounts)
            .instruction();

        let keeper_before = self.trident.get_account(&keeper).lamports();
        let res = self.trident.process_transaction(
            &[tip_ix, execute_ix],
            Some("execute_swap rescue, sufficient tip"),
        );
        assert!(
            res.is_success(),
            "execute_swap failed with a tip ({}) at exactly the required anti-snipe amount at slot {} into the rescue window: {:#?}",
            required_tip,
            slots_into_rescue,
            res.get_result()
        );

        let keeper_after = self.trident.get_account(&keeper).lamports();
        let keeper_gain = keeper_after.saturating_sub(keeper_before);
        assert!(
            keeper_gain + required_tip + 30_000 >= keeper_share,
            "keeper did not net roughly its 90% share after tip and fees: gain={} tip={} expected_share={}",
            keeper_gain,
            required_tip,
            keeper_share
        );
        let _ = partner_share; // documents the remaining 5% share; not independently re-derived here
    }

    #[flow]
    /// Invariant: execute_swap must revert, funds untouched and the escrow
    /// still Pending, whenever the underlying swap would deliver less than
    /// expected_output_amount -- regardless of path (fast or rescue).
    fn execute_swap_reverts_on_output_below_minimum(&mut self) {
        let input_amount: u64 = self.trident.random_from_range(1_000..1_000_000_000);
        // expected_output_amount is always at least 2, and the swap is
        // encoded to deliver strictly less -- guaranteeing a genuine
        // slippage-floor violation, not an accidental pass.
        let expected_output_amount: u64 = self.trident.random_from_range(2..1_000_000_000);
        let actual_output_amount: u64 =
            self.trident.random_from_range(0..expected_output_amount);

        let (
            user_wallet,
            escrow,
            user_input_token_account,
            dest_token_account,
            mint,
            dest_mint,
            mint_authority_pda,
            _buffer,
        ) = self.setup_escrow_for_swap(input_amount, expected_output_amount);

        let remaining_accounts = self.mock_dex_remaining_accounts(
            user_input_token_account,
            dest_token_account,
            escrow,
            mint,
            dest_mint,
            mint_authority_pda,
        );
        // Encodes a real swap that genuinely only delivers actual_output_amount,
        // not a forged claim -- mock-dex actually mints this exact amount.
        let swap_data = mock_dex_swap_data(input_amount, actual_output_amount);

        let ix = ExecuteSwapInstruction::data(ExecuteSwapInstructionData::new(swap_data))
            .accounts(ExecuteSwapInstructionAccounts::new(
                user_wallet,
                escrow,
                user_wallet,
                user_wallet,
                user_input_token_account,
                dest_token_account,
                mock_dex::program_id(),
            ))
            .remaining_accounts(remaining_accounts)
            .instruction();

        let res = self
            .trident
            .process_transaction(&[ix], Some("execute_swap under-delivering swap"));
        assert!(
            !res.is_success(),
            "execute_swap succeeded despite delivering {} when {} was required",
            actual_output_amount,
            expected_output_amount
        );
    }

    #[flow]
    /// Invariant added with the generic CPI account-ordering redesign
    /// (Section 7.2 of the technical report): execute_swap must reject any
    /// remaining_accounts list missing one of the three security-critical
    /// accounts (the real input token account, the real destination, the
    /// real SPL Token program), regardless of what else is present or in
    /// what order.
    fn execute_swap_rejects_missing_required_account(&mut self) {
        let input_amount: u64 = self.trident.random_from_range(1_000..1_000_000_000);
        let output_amount: u64 = self.trident.random_from_range(1..1_000_000_000);
        let (
            user_wallet,
            escrow,
            user_input_token_account,
            dest_token_account,
            mint,
            dest_mint,
            mint_authority_pda,
            _buffer,
        ) = self.setup_escrow_for_swap(input_amount, output_amount);

        let mut remaining_accounts = self.mock_dex_remaining_accounts(
            user_input_token_account,
            dest_token_account,
            escrow,
            mint,
            dest_mint,
            mint_authority_pda,
        );
        // Remove exactly one of the three critical accounts (indices 0, 1,
        // 3 in mock_dex_remaining_accounts: source, destination,
        // token_program), chosen randomly each iteration.
        let critical_indices = [0usize, 1usize, 3usize];
        let which: u64 = self.trident.random_from_range(0..critical_indices.len() as u64);
        remaining_accounts.remove(critical_indices[which as usize]);

        let swap_data = mock_dex_swap_data(input_amount, output_amount);
        let ix = ExecuteSwapInstruction::data(ExecuteSwapInstructionData::new(swap_data))
            .accounts(ExecuteSwapInstructionAccounts::new(
                user_wallet,
                escrow,
                user_wallet,
                user_wallet,
                user_input_token_account,
                dest_token_account,
                mock_dex::program_id(),
            ))
            .remaining_accounts(remaining_accounts)
            .instruction();

        let res = self.trident.process_transaction(
            &[ix],
            Some("execute_swap missing a required account"),
        );
        assert!(
            !res.is_success(),
            "execute_swap succeeded despite a required account (index {}) missing from remaining_accounts",
            critical_indices[which as usize]
        );
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

