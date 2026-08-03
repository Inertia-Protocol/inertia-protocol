import { AccountMeta, PublicKey, Connection } from "@solana/web3.js";
import BN from "bn.js";
import {
  makeSwapCpmmBaseInInstruction,
  getCreatePoolKeys,
  CpmmPoolInfoLayout,
} from "@raydium-io/raydium-sdk-v2";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

/**
 * Real swap-builder for Raydium's CPMM (Constant Product Market Maker)
 * program -- a second, independently-built, externally-existing Solana DEX,
 * distinct in both codebase and account layout from Orca Whirlpools
 * (orcaSwap.ts). Devnet program: DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb.
 *
 * Note on scope: Raydium's older, classic AMM (a separate, non-Anchor
 * program predating widespread Anchor adoption) uses a single-byte native
 * instruction tag, not an 8-byte Anchor discriminator -- incompatible with
 * EscrowState.expected_discriminator's fixed 8-byte assumption without a
 * further contract change. CPMM, Raydium's newer program, is genuinely
 * Anchor-based and fits Inertia's current design without modification,
 * which is why it was chosen here over the classic AMM.
 *
 * Like OrcaSwapBuilder, this uses the SDK's raw, low-level instruction
 * builder (makeSwapCpmmBaseInInstruction) rather than its wallet-bound
 * convenience wrapper, so no setup/cleanup instructions requiring a real
 * user signature get inserted -- the same constraint that ruled out
 * Jupiter's aggregator API applies to any convenience wrapper, not just
 * Jupiter's specifically.
 */
export class RaydiumCpmmSwapBuilder {
  constructor(
    private readonly connection: Connection,
    private readonly programId: PublicKey
  ) {}

  async buildSwap(params: {
    poolId: PublicKey;
    configId: PublicKey;
    userInputTokenAccount: PublicKey;
    destinationTokenAccount: PublicKey;
    inputMint: PublicKey;
    outputMint: PublicKey;
    escrowAuthority: PublicKey;
    amountIn: bigint;
    minimumAmountOut: bigint;
  }): Promise<{ swapInstructionData: Buffer; remainingAccounts: AccountMeta[] }> {
    const poolAccountInfo = await this.connection.getAccountInfo(params.poolId);
    if (!poolAccountInfo) throw new Error(`Pool ${params.poolId.toBase58()} not found`);
    const pool = CpmmPoolInfoLayout.decode(poolAccountInfo.data);

    const keys = getCreatePoolKeys({
      poolId: params.poolId,
      programId: this.programId,
      configId: params.configId,
      mintA: pool.mintA,
      mintB: pool.mintB,
    });

    const aToB = params.inputMint.equals(pool.mintA);
    const inputVault = aToB ? keys.vaultA : keys.vaultB;
    const outputVault = aToB ? keys.vaultB : keys.vaultA;

    const ix = makeSwapCpmmBaseInInstruction(
      this.programId,
      params.escrowAuthority, // payer -- doubles as the signing authority, forced true by execute_swap
      keys.authority,
      params.configId,
      params.poolId,
      params.userInputTokenAccount,
      params.destinationTokenAccount,
      inputVault,
      outputVault,
      TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      params.inputMint,
      params.outputMint,
      keys.observationId,
      new BN(params.amountIn.toString()),
      new BN(params.minimumAmountOut.toString())
    );

    // makeSwapCpmmBaseInInstruction marks payer (the escrow PDA) as
    // isSigner=true, since it assumes normal wallet use -- same real
    // constraint already found and fixed for Orca (a PDA cannot sign at
    // the outer-transaction level; only execute_swap's own invoke_signed
    // can grant that, internally, during the CPI itself).
    const remainingAccounts = (ix.keys as AccountMeta[]).map((meta) =>
      meta.pubkey.equals(params.escrowAuthority) ? { ...meta, isSigner: false } : meta
    );

    return {
      swapInstructionData: ix.data,
      remainingAccounts,
    };
  }
}
