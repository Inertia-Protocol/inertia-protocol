import {
  AnchorProvider,
  Idl,
  Program,
  BN,
} from "@coral-xyz/anchor";
import {
  AccountMeta,
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionSignature,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

import idlJson from "./idl/inertia_protocol.json" with { type: "json" };
import { deriveEscrowPda, randomNonce } from "./pda.js";
import { computeRescueTip } from "./antiSnipe.js";
import { randomJitoTipAccount, TREASURY_PUBKEY } from "./constants.js";

const IDL = idlJson as Idl;

export interface InitializeEscrowArgs {
  userWallet: PublicKey;
  userInputTokenAccount: PublicKey;
  expectedDestinationTokenAccount: PublicKey;
  gasBufferLamports: bigint;
  dynamicMinimumLamports: bigint;
  partnerWallet: PublicKey;
  inputAmount: bigint;
  expectedProgramId: PublicKey;
  expectedDiscriminator: Uint8Array; // exactly 8 bytes
  expectedOutputAmount: bigint;
  /** Omit to let the SDK generate a fresh random nonce. */
  nonce?: bigint;
}

export interface ExecuteSwapArgs {
  caller: PublicKey;
  escrow: PublicKey;
  swapInstructionData: Buffer;
  /** Accounts the underlying swap CPI needs beyond the fixed set -- program-specific, passed through as-is. */
  remainingAccounts: AccountMeta[];
  swapProgram: PublicKey;
  /**
   * If true (default), the SDK fetches the escrow's live state, computes
   * whether this is a rescue attempt and exactly what tip is currently
   * required per the anti-snipe curve, and prepends a correctly-sized tip
   * transfer automatically. Set false to manage the tip transfer yourself.
   */
  autoAttachTip?: boolean;
}

export interface SelfRescueArgs {
  userWallet: PublicKey;
  escrow: PublicKey;
  userInputTokenAccount: PublicKey;
}

export interface CleanupExpiredEscrowArgs {
  caller: PublicKey;
  escrow: PublicKey;
  userWallet: PublicKey;
}

export interface TopUpBufferArgs {
  contributor: PublicKey;
  escrow: PublicKey;
  amountLamports: bigint;
}

export interface EscrowStateAccount {
  userWallet: PublicKey;
  partnerWallet: PublicKey;
  userInputTokenAccount: PublicKey;
  inputAmount: bigint;
  expectedProgramId: PublicKey;
  expectedDiscriminator: Uint8Array;
  expectedDestinationTokenAccount: PublicKey;
  expectedOutputAmount: bigint;
  gasBufferLamports: bigint;
  creationSlot: bigint;
  ttlSlots: bigint;
  nonce: bigint;
  status: { pending?: {} } | { executed?: {} } | { rescued?: {} } | { expired?: {} };
  bump: number;
}

/**
 * Client SDK for Inertia Protocol. Wraps all five instructions plus account
 * fetching, and hides the anti-snipe tip calculation behind executeSwap()
 * so callers don't have to reimplement execute_swap.rs's decay curve by
 * hand to know what tip to attach.
 */
export class InertiaClient {
  public readonly program: Program;
  public readonly connection: Connection;

  constructor(provider: AnchorProvider) {
    this.program = new Program(IDL, provider);
    this.connection = provider.connection;
  }

  get programId(): PublicKey {
    return this.program.programId;
  }

  // ---------------------------------------------------------------------
  // initialize_escrow
  // ---------------------------------------------------------------------

  async initializeEscrow(
    args: InitializeEscrowArgs
  ): Promise<{ escrow: PublicKey; nonce: bigint; signature: TransactionSignature }> {
    const nonce = args.nonce ?? randomNonce();
    const [escrow] = deriveEscrowPda(this.programId, args.userWallet, nonce);

    if (args.expectedDiscriminator.length !== 8) {
      throw new Error("expectedDiscriminator must be exactly 8 bytes");
    }

    const params = {
      nonce: new BN(nonce.toString()),
      gasBufferLamports: new BN(args.gasBufferLamports.toString()),
      dynamicMinimumLamports: new BN(args.dynamicMinimumLamports.toString()),
      partnerWallet: args.partnerWallet,
      inputAmount: new BN(args.inputAmount.toString()),
      expectedProgramId: args.expectedProgramId,
      expectedDiscriminator: Array.from(args.expectedDiscriminator),
      expectedOutputAmount: new BN(args.expectedOutputAmount.toString()),
    };

    const signature = await this.program.methods
      .initializeEscrow(params)
      .accounts({
        userWallet: args.userWallet,
        userInputTokenAccount: args.userInputTokenAccount,
        expectedDestinationTokenAccount: args.expectedDestinationTokenAccount,
        escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return { escrow, nonce, signature };
  }

  // ---------------------------------------------------------------------
  // execute_swap
  // ---------------------------------------------------------------------

  /**
   * Builds the execute_swap instruction, auto-computing and prepending the
   * correct anti-snipe tip transfer if this is a rescue attempt (unless
   * autoAttachTip is explicitly false). Returns the raw instructions rather
   * than sending directly, since callers (especially keeper bots) generally
   * want control over compute budget instructions, priority fees, and
   * transaction assembly.
   */
  async buildExecuteSwapInstructions(
    args: ExecuteSwapArgs
  ): Promise<TransactionInstruction[]> {
    const instructions: TransactionInstruction[] = [];
    const autoAttachTip = args.autoAttachTip ?? true;

    if (autoAttachTip) {
      const escrowState = await this.getEscrow(args.escrow);
      if (!escrowState) {
        throw new Error(`Escrow ${args.escrow.toBase58()} not found`);
      }
      const currentSlot = BigInt(await this.connection.getSlot());
      const { isRescueEligible, requiredTipLamports } = computeRescueTip({
        gasBufferLamports: escrowState.gasBufferLamports,
        creationSlot: escrowState.creationSlot,
        currentSlot,
      });

      if (isRescueEligible) {
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: args.caller,
            toPubkey: randomJitoTipAccount(),
            lamports: requiredTipLamports,
          })
        );
      }
    }

    const escrowState = await this.getEscrow(args.escrow);
    if (!escrowState) {
      throw new Error(`Escrow ${args.escrow.toBase58()} not found`);
    }

    const executeIx = await this.program.methods
      .executeSwap(args.swapInstructionData)
      .accounts({
        caller: args.caller,
        escrow: args.escrow,
        userWallet: escrowState.userWallet,
        partnerWallet: escrowState.partnerWallet,
        treasury: TREASURY_PUBKEY,
        userInputTokenAccount: escrowState.userInputTokenAccount,
        destinationTokenAccount: escrowState.expectedDestinationTokenAccount,
        swapProgram: args.swapProgram,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts(args.remainingAccounts)
      .instruction();

    instructions.push(executeIx);
    return instructions;
  }

  /** Convenience wrapper: builds and sends the execute_swap transaction (with signer as fee payer). */
  async executeSwap(
    args: ExecuteSwapArgs,
    signers: Parameters<AnchorProvider["sendAndConfirm"]>[1]
  ): Promise<TransactionSignature> {
    const instructions = await this.buildExecuteSwapInstructions(args);
    const tx = new Transaction().add(...instructions);
    return this.program.provider.sendAndConfirm!(tx, signers);
  }

  // ---------------------------------------------------------------------
  // self_rescue
  // ---------------------------------------------------------------------

  async selfRescue(args: SelfRescueArgs): Promise<TransactionSignature> {
    return this.program.methods
      .selfRescue()
      .accounts({
        userWallet: args.userWallet,
        escrow: args.escrow,
        userInputTokenAccount: args.userInputTokenAccount,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  // ---------------------------------------------------------------------
  // cleanup_expired_escrow
  // ---------------------------------------------------------------------

  async cleanupExpiredEscrow(
    args: CleanupExpiredEscrowArgs
  ): Promise<TransactionSignature> {
    return this.program.methods
      .cleanupExpiredEscrow()
      .accounts({
        caller: args.caller,
        escrow: args.escrow,
        userWallet: args.userWallet,
      })
      .rpc();
  }

  // ---------------------------------------------------------------------
  // top_up_buffer
  // ---------------------------------------------------------------------

  async topUpBuffer(args: TopUpBufferArgs): Promise<TransactionSignature> {
    return this.program.methods
      .topUpBuffer(new BN(args.amountLamports.toString()))
      .accounts({
        contributor: args.contributor,
        escrow: args.escrow,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // ---------------------------------------------------------------------
  // Account fetching / helpers
  // ---------------------------------------------------------------------

  async getEscrow(escrow: PublicKey): Promise<EscrowStateAccount | null> {
    try {
      const raw = await (this.program.account as any).escrowState.fetch(escrow);
      return {
        userWallet: raw.userWallet,
        partnerWallet: raw.partnerWallet,
        userInputTokenAccount: raw.userInputTokenAccount,
        inputAmount: BigInt(raw.inputAmount.toString()),
        expectedProgramId: raw.expectedProgramId,
        expectedDiscriminator: Uint8Array.from(raw.expectedDiscriminator),
        expectedDestinationTokenAccount: raw.expectedDestinationTokenAccount,
        expectedOutputAmount: BigInt(raw.expectedOutputAmount.toString()),
        gasBufferLamports: BigInt(raw.gasBufferLamports.toString()),
        creationSlot: BigInt(raw.creationSlot.toString()),
        ttlSlots: BigInt(raw.ttlSlots.toString()),
        nonce: BigInt(raw.nonce.toString()),
        status: raw.status,
        bump: raw.bump,
      };
    } catch {
      return null;
    }
  }

  async getCurrentSlot(): Promise<bigint> {
    return BigInt(await this.connection.getSlot());
  }
}
