// Real, end-to-end demo of Inertia's execute_swap against Raydium's CPMM --
// a second, independently-built, externally-existing Solana DEX, distinct
// in both codebase and account layout from Orca Whirlpools. Creates a real
// pool (own tokens, own liquidity, avoiding dependency on any third party's
// ephemeral devnet test pool), then executes a genuine rescue through it.
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, Wallet } = anchorPkg;
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import { readFileSync } from "node:fs";
import { makeCreateCpmmPoolInInstruction, getCreatePoolKeys } from "@raydium-io/raydium-sdk-v2";
import { InertiaClient, deriveEscrowPda } from "@inertia-protocol/sdk";
import { RaydiumCpmmSwapBuilder } from "./dist/raydiumCpmmSwap.js";

const INERTIA_PROGRAM_ID = new PublicKey("8ST3LRU5gv8ijZehvXdwRzc6VnvqbVozCCdFzEzqhqbW");
const CPMM_PROGRAM_ID = new PublicKey("DRaycpLY18LhpbydsBWbVJtxpNv9oXPgjRSfpF2bWpYb");
// Real, existing devnet AmmConfig (index 0), confirmed against a live pool's
// own API data and decoded on-chain -- not invented.
const AMM_CONFIG_ID = new PublicKey("5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy");
// Real devnet pool-creation fee receiver, read directly out of the deployed
// program's own source (create_pool_fee_reveiver::ID under #[cfg(feature = "devnet")]).
const CREATE_POOL_FEE_RECEIVER = new PublicKey("3oE58BKVt8KuYkGxx8zBojugnymWmBiyafWgMrnb6eYy");

function record(label, sig) {
  console.log(`${label}: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
}

async function main() {
  const keypairPath = process.env.DEVNET_PAYER;
  if (!keypairPath) throw new Error("Set DEVNET_PAYER to a keypair JSON path");
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))));

  const connection = new Connection("https://api.devnet.solana.com", "confirmed");
  const provider = new AnchorProvider(connection, new Wallet(payer), {});
  const inertia = new InertiaClient(provider);

  console.log("Payer:", payer.publicKey.toBase58());

  // --- Create two fresh mints, sorted so mintA < mintB (Raydium enforces
  // this on-chain: token_0_mint.key() < token_1_mint.key()).
  let mintX = await createMint(connection, payer, payer.publicKey, null, 6);
  let mintY = await createMint(connection, payer, payer.publicKey, null, 6);
  const [mintA, mintB] = mintX.toBuffer().compare(mintY.toBuffer()) < 0 ? [mintX, mintY] : [mintY, mintX];
  console.log("mintA:", mintA.toBase58(), "mintB:", mintB.toBase58());

  const creatorAtaA = await getOrCreateAssociatedTokenAccount(connection, payer, mintA, payer.publicKey);
  const creatorAtaB = await getOrCreateAssociatedTokenAccount(connection, payer, mintB, payer.publicKey);
  const LIQUIDITY_AMOUNT = 1_000_000_000; // 1000 tokens @ 6 decimals, each side
  await mintTo(connection, payer, mintA, creatorAtaA.address, payer, LIQUIDITY_AMOUNT);
  await mintTo(connection, payer, mintB, creatorAtaB.address, payer, LIQUIDITY_AMOUNT);
  console.log("Minted real liquidity tokens to creator's own accounts.");

  // --- Real pool creation, using the SDK's real PDA derivation + the raw,
  // low-level instruction builder (no convenience wrapper).
  const keys = getCreatePoolKeys({ programId: CPMM_PROGRAM_ID, configId: AMM_CONFIG_ID, mintA, mintB });
  const creatorLpAta = getAssociatedTokenAddressSync(keys.lpMint, payer.publicKey);

  const createPoolIx = makeCreateCpmmPoolInInstruction(
    CPMM_PROGRAM_ID,
    payer.publicKey,
    AMM_CONFIG_ID,
    keys.authority,
    keys.poolId,
    mintA,
    mintB,
    keys.lpMint,
    creatorAtaA.address,
    creatorAtaB.address,
    creatorLpAta,
    keys.vaultA,
    keys.vaultB,
    CREATE_POOL_FEE_RECEIVER,
    TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    keys.observationId,
    new BN(LIQUIDITY_AMOUNT),
    new BN(LIQUIDITY_AMOUNT),
    new BN(0) // openTime: 0 = open immediately
  );

  // creator_lp_token is created internally by the program itself (an Anchor
  // `init` + associated_token constraint), not something the client
  // pre-creates -- unlike the destination ATA pattern used elsewhere in
  // this project, which the target program does NOT create for you.
  const createPoolTx = new Transaction().add(createPoolIx);
  const createPoolSig = await sendAndConfirmTransaction(connection, createPoolTx, [payer]);
  record("create real Raydium CPMM pool (own tokens, own liquidity)", createPoolSig);
  console.log("Pool:", keys.poolId.toBase58());

  // --- Now the real Inertia flow: initialize_escrow, then execute_swap
  // CPI-ing into this real, independently-built program, with the escrow
  // PDA as the delegated authority.
  const swapBuilder = new RaydiumCpmmSwapBuilder(connection, CPMM_PROGRAM_ID);
  const nonce = BigInt(Date.now());
  const [escrow] = deriveEscrowPda(INERTIA_PROGRAM_ID, payer.publicKey, nonce);

  const userInputAta = getAssociatedTokenAddressSync(mintA, payer.publicKey);
  const userOutputAta = getAssociatedTokenAddressSync(mintB, payer.publicKey);
  const inputAmount = 10_000_000n; // 10 tokens

  // All the earlier-minted mintA supply went into the pool as liquidity --
  // mint a bit more specifically to swap with, separate from that.
  const swapMintSig = await mintTo(connection, payer, mintA, userInputAta, payer, Number(inputAmount));
  record("mint tokens for the swap itself", swapMintSig);

  const { swapInstructionData, remainingAccounts } = await swapBuilder.buildSwap({
    poolId: keys.poolId,
    configId: AMM_CONFIG_ID,
    userInputTokenAccount: userInputAta,
    destinationTokenAccount: userOutputAta,
    inputMint: mintA,
    outputMint: mintB,
    escrowAuthority: escrow,
    amountIn: inputAmount,
    minimumAmountOut: 1n,
  });
  const expectedDiscriminator = swapInstructionData.subarray(0, 8);

  const { signature: initSig } = await inertia.initializeEscrow({
    userWallet: payer.publicKey,
    userInputTokenAccount: userInputAta,
    expectedDestinationTokenAccount: userOutputAta,
    gasBufferLamports: 40_000_000n,
    dynamicMinimumLamports: 40_000_000n,
    partnerWallet: payer.publicKey,
    inputAmount,
    expectedProgramId: CPMM_PROGRAM_ID,
    expectedDiscriminator,
    expectedOutputAmount: 1n,
    nonce,
  });
  record("initialize_escrow (real Raydium CPMM route)", initSig);

  // Same real-latency hedge already proven necessary for both prior demos:
  // the pool-creation and pool-fetch calls above take real time, so by the
  // time this lands the 2-slot TTL may already have elapsed.
  const instructions = await inertia.buildExecuteSwapInstructions({
    caller: payer.publicKey,
    escrow,
    swapInstructionData: Buffer.from(swapInstructionData),
    remainingAccounts,
    swapProgram: CPMM_PROGRAM_ID,
    autoAttachTip: false,
  });
  const hedgeTipIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
    lamports: 40_000_000,
  });
  const tx = new Transaction().add(hedgeTipIx, ...instructions);
  const sig = await provider.sendAndConfirm(tx, [payer]);
  record("execute_swap (real CPI into Raydium CPMM)", sig);

  const destBalance = await connection.getTokenAccountBalance(userOutputAta);
  console.log("Real swap output received:", destBalance.value.uiAmountString, "of", mintB.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
