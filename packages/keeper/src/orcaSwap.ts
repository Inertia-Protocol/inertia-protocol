import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, BN } = anchorPkg;
type AnchorProvider = InstanceType<typeof anchorPkg.AnchorProvider>;

import { AccountMeta, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";
import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  swapQuoteByInputToken,
  SwapUtils,
  WhirlpoolIx,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  IGNORE_CACHE,
} from "@orca-so/whirlpools-sdk";
import { Percentage } from "@orca-so/common-sdk";

/**
 * Real swap-builder for Orca Whirlpools, Solana's independently-built,
 * externally-audited concentrated-liquidity DEX -- not a program written for
 * this project (contrast mockDexSwap.ts). Devnet program:
 * whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc.
 *
 * This only works because Whirlpools' real swap instruction is a single
 * instruction with an explicit tokenAuthority parameter (not a wallet-bound
 * convenience wrapper that inserts setup/cleanup steps needing a real
 * signer, the way Jupiter's aggregated routing does -- see the project's
 * own build log for why that path was ruled out). It requires
 * execute_swap's generic, caller-ordered remaining_accounts design
 * (Section on the account-ordering redesign in the technical report) --
 * Whirlpools' own account order has nothing to do with Inertia's and would
 * not fit the old hardcoded prefix.
 */
export class OrcaSwapBuilder {
  private readonly ctx: WhirlpoolContext;
  private readonly client: ReturnType<typeof buildWhirlpoolClient>;

  constructor(provider: AnchorProvider, programId: PublicKey = ORCA_WHIRLPOOL_PROGRAM_ID) {
    this.ctx = WhirlpoolContext.withProvider(provider as any, undefined, undefined, undefined, programId);
    this.client = buildWhirlpoolClient(this.ctx);
  }

  get programId(): PublicKey {
    return this.ctx.program.programId;
  }

  /**
   * Given a real, live Whirlpool pool address and an escrow's known input
   * amount + token accounts, fetches a real quote and builds the real swap
   * instruction with `tokenAuthority` set to the escrow PDA -- the same
   * delegated-authority pattern already proven against mock-dex, just
   * against a real, independently-deployed program this time.
   */
  async buildSwap(params: {
    whirlpoolAddress: PublicKey;
    userInputTokenAccount: PublicKey;
    destinationTokenAccount: PublicKey;
    inputMint: PublicKey;
    inputAmount: bigint;
    escrowAuthority: PublicKey;
    slippageBps?: number;
  }): Promise<{ swapInstructionData: Buffer; remainingAccounts: AccountMeta[] }> {
    const pool = await this.client.getPool(params.whirlpoolAddress, IGNORE_CACHE);
    const poolData = pool.getData();

    const slippage = Percentage.fromFraction(params.slippageBps ?? 50, 10_000);
    const quote = await swapQuoteByInputToken(
      pool,
      params.inputMint,
      new BN(params.inputAmount.toString()),
      slippage,
      this.ctx.program.programId,
      this.ctx.fetcher,
      IGNORE_CACHE
    );

    const swapParams = SwapUtils.getSwapParamsFromQuoteKeys(
      quote,
      this.ctx,
      params.whirlpoolAddress,
      poolData.tokenVaultA,
      poolData.tokenVaultB,
      params.userInputTokenAccount,
      params.destinationTokenAccount,
      params.escrowAuthority
    );

    const ix = WhirlpoolIx.swapIx(this.ctx.program, swapParams);
    const rawIx = ix.instructions[0];

    // Real Whirlpools requires ordinary SPL token accounts to already exist
    // on both sides -- reading them back is just a sanity check the escrow's
    // known accounts are real and match the mints this pool actually trades,
    // not a network call the swap itself depends on.
    await getAccount(this.ctx.connection, params.userInputTokenAccount);
    await getAccount(this.ctx.connection, params.destinationTokenAccount);

    // Whirlpools' own instruction-builder marks tokenAuthority (the escrow
    // PDA) as isSigner=true, since it assumes normal wallet use. A PDA has
    // no keypair and cannot sign at the outer-transaction level -- only
    // execute_swap's own invoke_signed can grant that, internally, during
    // the CPI itself (see the account-ordering redesign). Force it back to
    // false here so the outer transaction Solana actually verifies doesn't
    // wrongly claim the escrow can sign for itself.
    const remainingAccounts = (rawIx.keys as AccountMeta[]).map((meta) =>
      meta.pubkey.equals(params.escrowAuthority) ? { ...meta, isSigner: false } : meta
    );

    return {
      swapInstructionData: rawIx.data as Buffer,
      remainingAccounts,
    };
  }
}

export const ORCA_WHIRLPOOL_DEVNET_PROGRAM_ID = ORCA_WHIRLPOOL_PROGRAM_ID;
