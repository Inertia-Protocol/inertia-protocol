import anchorPkg from "@coral-xyz/anchor";
import type { Idl } from "@coral-xyz/anchor";
const { BN, Program } = anchorPkg;
type Program = InstanceType<typeof anchorPkg.Program>;
type AnchorProvider = InstanceType<typeof anchorPkg.AnchorProvider>;

import { AccountMeta, PublicKey } from "@solana/web3.js";
import { getAccount } from "@solana/spl-token";

import idlJson from "./idl/mock_dex.json" with { type: "json" };

const MOCK_DEX_IDL = idlJson as Idl;

/**
 * Builds a mock-dex swap instruction for a given escrow's known parameters.
 *
 * THIS IS THE PLUGGABLE PART. mock-dex is the only swap program that exists
 * in this repo today, so this is a reference implementation proving the
 * keeper's timing and profitability logic actually works end to end -- not
 * a real DEX integration. A production keeper would replace this with a
 * real aggregator client (Jupiter or similar), quoting a route that clears
 * expectedOutputAmount and returning that route's own instruction data and
 * accounts instead.
 */
export class MockDexSwapBuilder {
  private readonly program: Program;

  constructor(provider: AnchorProvider) {
    this.program = new Program(MOCK_DEX_IDL, provider);
  }

  get programId(): PublicKey {
    return this.program.programId;
  }

  private mintAuthorityPda(): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority")],
      this.programId
    );
    return pda;
  }

  /**
   * Given an escrow's known input/output token accounts and amounts,
   * resolves their mints (real RPC reads -- EscrowState doesn't store mints
   * directly, only the token accounts) and builds the swap instruction data
   * plus the remaining accounts mock-dex's CPI needs.
   */
  async buildSwap(params: {
    userInputTokenAccount: PublicKey;
    destinationTokenAccount: PublicKey;
    inputAmount: bigint;
    outputAmount: bigint;
  }): Promise<{ swapInstructionData: Buffer; remainingAccounts: AccountMeta[] }> {
    const connection = this.program.provider.connection;

    const [inputAccountInfo, outputAccountInfo] = await Promise.all([
      getAccount(connection, params.userInputTokenAccount),
      getAccount(connection, params.destinationTokenAccount),
    ]);

    const swapInstructionData = this.program.coder.instruction.encode("swap", {
      amountIn: new BN(params.inputAmount.toString()),
      amountOut: new BN(params.outputAmount.toString()),
    });

    const remainingAccounts: AccountMeta[] = [
      { pubkey: inputAccountInfo.mint, isSigner: false, isWritable: true },
      { pubkey: outputAccountInfo.mint, isSigner: false, isWritable: true },
      { pubkey: this.mintAuthorityPda(), isSigner: false, isWritable: false },
    ];

    return { swapInstructionData, remainingAccounts };
  }
}
