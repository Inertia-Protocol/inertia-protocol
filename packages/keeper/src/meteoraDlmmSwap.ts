import { AccountMeta, PublicKey, Connection, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import BN from "bn.js";
// @meteora-ag/dlmm's own ESM build has a real packaging bug (a directory
// import Node's strict ESM resolver rejects, in a nested @coral-xyz/anchor
// dependency) -- routed around via the working CJS build, same as the
// devnet demo script that exercises this class.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const dlmmPkg = require("@meteora-ag/dlmm");
const DLMM = dlmmPkg.default ?? dlmmPkg;

/**
 * Real swap-builder for Meteora's DLMM (Dynamic Liquidity Market Maker) --
 * a third, independently-built, externally-existing Solana DEX, using a
 * discrete-bin liquidity model distinct from both Orca Whirlpools'
 * continuous ticks (orcaSwap.ts) and Raydium CPMM's flat constant-product
 * curve (raydiumCpmmSwap.ts). Real devnet deployment, same address as
 * mainnet: LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo.
 *
 * Like the other two, this deliberately does not use the SDK's own
 * swap()-and-send convenience flow uncritically -- it extracts the raw
 * swap instruction from the Transaction that builder returns and discards
 * everything else, so no setup step requiring a real end-user signature
 * can sneak into the CPI the same way Jupiter's aggregator API did.
 */
export class MeteoraDlmmSwapBuilder {
  constructor(private readonly connection: Connection) {}

  async buildSwap(params: {
    poolAddress: PublicKey;
    userInputTokenAccount: PublicKey;
    destinationTokenAccount: PublicKey;
    inputMint: PublicKey;
    outputMint: PublicKey;
    escrowAuthority: PublicKey;
    amountIn: bigint;
    minOutAmount: bigint;
  }): Promise<{ swapInstructionData: Buffer; remainingAccounts: AccountMeta[] }> {
    const pool = await DLMM.create(this.connection, params.poolAddress);
    const swapForY = params.inputMint.equals(pool.lbPair.tokenXMint);

    const binArrays: { publicKey: PublicKey }[] = await pool.getBinArrayForSwap(swapForY);

    const tx = await pool.swap({
      inToken: params.inputMint,
      outToken: params.outputMint,
      inAmount: new BN(params.amountIn.toString()),
      minOutAmount: new BN(params.minOutAmount.toString()),
      lbPair: params.poolAddress,
      user: params.escrowAuthority, // doubles as the signing authority, forced true by execute_swap
      binArraysPubkey: binArrays.map((b) => b.publicKey),
    });

    const swapIx: TransactionInstruction | undefined = tx.instructions.find((ix: TransactionInstruction) =>
      ix.programId.equals(pool.program.programId)
    );
    if (!swapIx) {
      throw new Error(
        `No instruction targeting the DLMM program found in the built transaction (${tx.instructions.length} total) -- ` +
          "the SDK may have changed its swap() output shape."
      );
    }

    // SwapParams has no explicit input/output token-account fields -- the
    // SDK derives them itself as the standard ATA for (mint, user). Since
    // `user` is the escrow PDA here, not the real end-user wallet that
    // actually owns the tokens, that derived address is a real account
    // Inertia's escrow doesn't own or control. Replace it by value with
    // the escrow's real, already-delegated user_input_token_account /
    // expected_destination_token_account wherever it appears, rather than
    // trust the SDK's assumption that swap authority == token owner.
    const escrowDerivedInputAta = getAssociatedTokenAddressSync(params.inputMint, params.escrowAuthority, true);
    const escrowDerivedOutputAta = getAssociatedTokenAddressSync(params.outputMint, params.escrowAuthority, true);

    // Same real constraint already found and fixed for both Orca and
    // Raydium, independently rediscovered here: the SDK's instruction
    // builder marks the authority (the escrow PDA) as isSigner=true,
    // assuming normal wallet use. Only execute_swap's own invoke_signed
    // can actually grant a PDA that status.
    const remainingAccounts = (swapIx.keys as AccountMeta[]).map((meta) => {
      if (meta.pubkey.equals(escrowDerivedInputAta)) {
        return { ...meta, pubkey: params.userInputTokenAccount, isSigner: false };
      }
      if (meta.pubkey.equals(escrowDerivedOutputAta)) {
        return { ...meta, pubkey: params.destinationTokenAccount, isSigner: false };
      }
      return meta.pubkey.equals(params.escrowAuthority) ? { ...meta, isSigner: false } : meta;
    });

    return {
      swapInstructionData: swapIx.data,
      remainingAccounts,
    };
  }
}
