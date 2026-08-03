// Real, end-to-end demo of Inertia's execute_swap against Meteora's DLMM --
// a third, independently-built, externally-existing Solana DEX, using a
// discrete-bin liquidity model distinct from both prior integrations.
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
} from "@solana/spl-token";
import BN from "bn.js";
import { readFileSync } from "node:fs";
// @meteora-ag/dlmm's own ESM build (dist/index.mjs) has a real packaging bug:
// it directory-imports a nested @coral-xyz/anchor path Node's strict ESM
// resolver rejects. Route around it via the working CJS build instead of
// the broken "import" condition in its package.json exports map.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const dlmmPkg = require("@meteora-ag/dlmm");
const DLMM = dlmmPkg.default ?? dlmmPkg;
const { ActivationType, StrategyType, deriveCustomizablePermissionlessLbPair, LBCLMM_PROGRAM_IDS } = dlmmPkg;
import { InertiaClient, deriveEscrowPda, MeteoraDlmmSwapBuilder } from "@inertia-protocol/sdk";

const INERTIA_PROGRAM_ID = new PublicKey("8ST3LRU5gv8ijZehvXdwRzc6VnvqbVozCCdFzEzqhqbW");

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

  // --- Two fresh mints, real liquidity actually minted -- same discipline
  // as the Raydium integration: a real pool this project controls, not a
  // dependency on a third party's ephemeral devnet test pool.
  let mintX = await createMint(connection, payer, payer.publicKey, null, 6);
  let mintY = await createMint(connection, payer, payer.publicKey, null, 6);
  const [tokenX, tokenY] =
    mintX.toBuffer().compare(mintY.toBuffer()) < 0 ? [mintX, mintY] : [mintY, mintX];
  console.log("tokenX:", tokenX.toBase58(), "tokenY:", tokenY.toBase58());

  const ataX = await getOrCreateAssociatedTokenAccount(connection, payer, tokenX, payer.publicKey);
  const ataY = await getOrCreateAssociatedTokenAccount(connection, payer, tokenY, payer.publicKey);
  const LIQUIDITY_AMOUNT = 1_000_000_000; // 1000 tokens @ 6 decimals, each side
  await mintTo(connection, payer, tokenX, ataX.address, payer, LIQUIDITY_AMOUNT * 2);
  await mintTo(connection, payer, tokenY, ataY.address, payer, LIQUIDITY_AMOUNT);
  console.log("Minted real liquidity + swap tokens to own accounts.");

  // --- Real pool creation: binStep 20 (0.20% per bin), activeId 0 (1:1
  // nominal starting price, matching equal-decimal fresh mints), fee 20 bps.
  const binStep = new BN(20);
  const activeId = new BN(0);
  const feeBps = new BN(20);
  const createTx = await DLMM.createCustomizablePermissionlessLbPair2(
    connection,
    binStep,
    tokenX,
    tokenY,
    activeId,
    feeBps,
    ActivationType.Slot,
    false, // hasAlphaVault
    payer.publicKey,
    undefined,
    true // creatorPoolOnOffControl
  );
  const createSig = await sendAndConfirmTransaction(connection, createTx, [payer]);
  record("create real Meteora DLMM pool (own tokens, own liquidity)", createSig);

  const dlmmProgramId = new PublicKey(LBCLMM_PROGRAM_IDS["devnet"]);
  const [realPoolAddress] = deriveCustomizablePermissionlessLbPair(tokenX, tokenY, dlmmProgramId);
  console.log("Pool:", realPoolAddress.toBase58());

  // --- Seed real liquidity into a single, simple spot position around the
  // active bin -- the minimum needed for a real, swappable pool.
  const pool = await DLMM.create(connection, realPoolAddress);
  const positionKeypair = Keypair.generate();
  const addLiquidityTx = await pool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionKeypair.publicKey,
    totalXAmount: new BN(LIQUIDITY_AMOUNT),
    totalYAmount: new BN(LIQUIDITY_AMOUNT),
    strategy: {
      maxBinId: activeId.toNumber() + 10,
      minBinId: activeId.toNumber() - 10,
      strategyType: StrategyType.Spot,
    },
    user: payer.publicKey,
  });
  const addLiquiditySig = await sendAndConfirmTransaction(connection, addLiquidityTx, [
    payer,
    positionKeypair,
  ]);
  record("add real liquidity to the pool", addLiquiditySig);

  // --- The real Inertia flow.
  const swapBuilder = new MeteoraDlmmSwapBuilder(connection);
  const nonce = BigInt(Date.now());
  const [escrow] = deriveEscrowPda(INERTIA_PROGRAM_ID, payer.publicKey, nonce);

  const userInputAta = getAssociatedTokenAddressSync(tokenX, payer.publicKey);
  const userOutputAta = getAssociatedTokenAddressSync(tokenY, payer.publicKey);
  const inputAmount = 10_000_000n; // 10 tokens

  const { swapInstructionData, remainingAccounts } = await swapBuilder.buildSwap({
    poolAddress: realPoolAddress,
    userInputTokenAccount: userInputAta,
    destinationTokenAccount: userOutputAta,
    inputMint: tokenX,
    outputMint: tokenY,
    escrowAuthority: escrow,
    amountIn: inputAmount,
    minOutAmount: 1n,
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
    expectedProgramId: new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"),
    expectedDiscriminator,
    expectedOutputAmount: 1n,
    nonce,
  });
  record("initialize_escrow (real Meteora DLMM route)", initSig);

  const instructions = await inertia.buildExecuteSwapInstructions({
    caller: payer.publicKey,
    escrow,
    swapInstructionData: Buffer.from(swapInstructionData),
    remainingAccounts,
    swapProgram: new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"),
    autoAttachTip: false,
  });
  const hedgeTipIx = SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: new PublicKey("96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"),
    lamports: 40_000_000,
  });
  const tx = new Transaction().add(hedgeTipIx, ...instructions);
  const sig = await provider.sendAndConfirm(tx, [payer]);
  record("execute_swap (real CPI into Meteora DLMM)", sig);

  const destBalance = await connection.getTokenAccountBalance(userOutputAta);
  console.log("Real swap output received:", destBalance.value.uiAmountString, "of", tokenY.toBase58());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
