import { PublicKey } from "@solana/web3.js";
import { ESCROW_SEED } from "./constants.js";

/**
 * Derives the escrow PDA for a given (user_wallet, nonce) pair -- must match
 * the seeds in initialize_escrow's Accounts struct exactly:
 * [ESCROW_SEED, user_wallet, nonce.to_le_bytes()].
 */
export function deriveEscrowPda(
  programId: PublicKey,
  userWallet: PublicKey,
  nonce: bigint
): [PublicKey, number] {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(nonce);

  return PublicKey.findProgramAddressSync(
    [ESCROW_SEED, userWallet.toBuffer(), nonceBytes],
    programId
  );
}

/** Generates a fresh, random nonce for a new escrow. */
export function randomNonce(): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return new DataView(bytes.buffer).getBigUint64(0, true);
}
