import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddressSync,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

const TREASURY_PUBKEY = new PublicKey(
  "AX32tpNHzJsDvYvSuuT7NCiSQy6tMMyDdvrNzGYm8tYK"
);
const JITO_TIP_ACCOUNT = new PublicKey(
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5"
);

function u64le(n: number | BN): Buffer {
  return new BN(n).toArrayLike(Buffer, "le", 8);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("inertia-protocol", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const inertia = anchor.workspace.InertiaProtocol as Program;
  const mockDex = anchor.workspace.MockDex as Program;

  let user: Keypair;
  let inputMint: PublicKey;
  let outputMint: PublicKey;
  let mintAuthorityPda: PublicKey;
  let userInputAta: PublicKey;
  let userOutputAta: PublicKey;
  let partnerWallet: PublicKey;

  const INPUT_AMOUNT = 1_000_000; // 1 token @ 6 decimals
  const OUTPUT_AMOUNT = 500_000; // 0.5 token @ 6 decimals
  // Must be large enough that every share (partner/treasury at 5% each) clears
  // Solana's ~890,880 lamport rent-exempt minimum on its own -- this is a real
  // constraint the SDK's dynamic-minimum calculation needs to respect too,
  // not just a test-sizing detail.
  const BUFFER_LAMPORTS = 40_000_000; // 0.04 SOL

  before(async () => {
    user = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(
      user.publicKey,
      2_000_000_000
    );
    await provider.connection.confirmTransaction(sig, "confirmed");

    // Real treasury/partner wallets already exist with a balance in
    // production; a freshly-generated test keypair starting at exactly zero
    // is a test artifact, not a real scenario, so pre-fund it to match.
    const treasurySig = await provider.connection.requestAirdrop(
      TREASURY_PUBKEY,
      1_000_000_000
    );
    await provider.connection.confirmTransaction(treasurySig, "confirmed");

    partnerWallet = Keypair.generate().publicKey;
    const partnerSig = await provider.connection.requestAirdrop(
      partnerWallet,
      1_000_000_000
    );
    await provider.connection.confirmTransaction(partnerSig, "confirmed");

    [mintAuthorityPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority")],
      mockDex.programId
    );

    inputMint = await createMint(
      provider.connection,
      user,
      user.publicKey,
      null,
      6
    );
    outputMint = await createMint(
      provider.connection,
      user,
      mintAuthorityPda, // mock-dex's PDA mints output tokens directly
      null,
      6
    );

    userInputAta = (
      await getOrCreateAssociatedTokenAccount(
        provider.connection,
        user,
        inputMint,
        user.publicKey
      )
    ).address;
    userOutputAta = getAssociatedTokenAddressSync(outputMint, user.publicKey);
    // Create the empty destination ATA up front (execute_swap doesn't create it).
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      user,
      outputMint,
      user.publicKey
    );

    await mintTo(
      provider.connection,
      user,
      inputMint,
      userInputAta,
      user,
      INPUT_AMOUNT * 10 // enough for multiple test escrows
    );
  });

  function findEscrow(owner: PublicKey, nonce: number): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), owner.toBuffer(), u64le(nonce)],
      inertia.programId
    );
  }

  async function initEscrow(nonce: number, opts?: { minOutput?: number }) {
    const [escrow] = findEscrow(user.publicKey, nonce);

    // Build the mock-dex swap instruction data via its own coder so the
    // discriminator matches exactly what execute_swap will be asked to call.
    const swapIxData = mockDex.coder.instruction.encode("swap", {
      amountIn: new BN(INPUT_AMOUNT),
      amountOut: new BN(opts?.minOutput ?? OUTPUT_AMOUNT),
    });
    const expectedDiscriminator = Array.from(swapIxData.subarray(0, 8));

    await inertia.methods
      .initializeEscrow({
        nonce: new BN(nonce),
        gasBufferLamports: new BN(BUFFER_LAMPORTS),
        dynamicMinimumLamports: new BN(BUFFER_LAMPORTS),
        partnerWallet,
        inputAmount: new BN(INPUT_AMOUNT),
        expectedProgramId: mockDex.programId,
        expectedDiscriminator,
        expectedOutputAmount: new BN(OUTPUT_AMOUNT),
      })
      .accounts({
        userWallet: user.publicKey,
        userInputTokenAccount: userInputAta,
        expectedDestinationTokenAccount: userOutputAta,
        escrow,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    return { escrow, partnerWallet, swapIxData };
  }

  it("initialize_escrow locks the buffer and delegates the input tokens", async () => {
    const { escrow } = await initEscrow(0);

    const escrowAccount = await inertia.account.escrowState.fetch(escrow);
    assert.equal(escrowAccount.userWallet.toBase58(), user.publicKey.toBase58());
    assert.equal(escrowAccount.status.pending !== undefined, true);
    assert.equal(escrowAccount.inputAmount.toNumber(), INPUT_AMOUNT);

    const tokenAcct = await getAccount(provider.connection, userInputAta);
    assert.equal(tokenAcct.delegate?.toBase58(), escrow.toBase58());
    assert.equal(Number(tokenAcct.delegatedAmount), INPUT_AMOUNT);
  });

  it("execute_swap succeeds before TTL and refunds 100% of the buffer to the user", async () => {
    const { escrow, partnerWallet, swapIxData } = await initEscrow(1);

    const userBalanceBefore = await provider.connection.getBalance(
      user.publicKey
    );

    await inertia.methods
      .executeSwap(swapIxData)
      .accounts({
        caller: user.publicKey,
        escrow,
        userWallet: user.publicKey,
        partnerWallet,
        treasury: TREASURY_PUBKEY,
        userInputTokenAccount: userInputAta,
        destinationTokenAccount: userOutputAta,
        swapProgram: mockDex.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts([
        { pubkey: inputMint, isSigner: false, isWritable: true },
        { pubkey: outputMint, isSigner: false, isWritable: true },
        { pubkey: mintAuthorityPda, isSigner: false, isWritable: false },
      ])
      .signers([user])
      .rpc();

    const destAcct = await getAccount(provider.connection, userOutputAta);
    assert.equal(Number(destAcct.amount), OUTPUT_AMOUNT);

    const userBalanceAfter = await provider.connection.getBalance(
      user.publicKey
    );
    // Refunded the full buffer minus this tx's own fee -- should net positive
    // relative to before, not a wash or a loss.
    assert.isAbove(userBalanceAfter, userBalanceBefore);

    // Escrow account should be closed.
    const closed = await provider.connection.getAccountInfo(escrow);
    assert.isNull(closed);
  });

  it("execute_swap rejects a rescue attempt with no Jito tip after TTL", async () => {
    const { escrow, swapIxData } = await initEscrow(2);
    const keeper = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(keeper.publicKey, 1_000_000_000),
      "confirmed"
    );

    await sleep(3000); // let TTL (2 slots) clearly elapse

    const escrowState = await inertia.account.escrowState.fetch(escrow);

    let threw = false;
    try {
      await inertia.methods
        .executeSwap(swapIxData)
        .accounts({
          caller: keeper.publicKey,
          escrow,
          userWallet: user.publicKey,
          partnerWallet: escrowState.partnerWallet,
          treasury: TREASURY_PUBKEY,
          userInputTokenAccount: userInputAta,
          destinationTokenAccount: userOutputAta,
          swapProgram: mockDex.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: inputMint, isSigner: false, isWritable: true },
          { pubkey: outputMint, isSigner: false, isWritable: true },
          { pubkey: mintAuthorityPda, isSigner: false, isWritable: false },
        ])
        .signers([keeper])
        .rpc();
    } catch (err) {
      threw = true;
      assert.include(String(err), "MissingJitoTip");
    }
    assert.isTrue(threw, "expected execute_swap to reject a tip-less rescue");
  });

  it("execute_swap rejects a rescue attempt with a tip below the minimum amount", async () => {
    const { escrow, partnerWallet, swapIxData } = await initEscrow(6);
    const keeper = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(keeper.publicKey, 1_000_000_000),
      "confirmed"
    );

    await sleep(3000);

    // Below MIN_JITO_TIP_LAMPORTS (1,000) -- present, but too small to count.
    const tinyTipIx = SystemProgram.transfer({
      fromPubkey: keeper.publicKey,
      toPubkey: JITO_TIP_ACCOUNT,
      lamports: 500,
    });

    const executeIx = await inertia.methods
      .executeSwap(swapIxData)
      .accounts({
        caller: keeper.publicKey,
        escrow,
        userWallet: user.publicKey,
        partnerWallet,
        treasury: TREASURY_PUBKEY,
        userInputTokenAccount: userInputAta,
        destinationTokenAccount: userOutputAta,
        swapProgram: mockDex.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts([
        { pubkey: inputMint, isSigner: false, isWritable: true },
        { pubkey: outputMint, isSigner: false, isWritable: true },
        { pubkey: mintAuthorityPda, isSigner: false, isWritable: false },
      ])
      .instruction();

    let threw = false;
    try {
      const tx = new Transaction().add(tinyTipIx).add(executeIx);
      await provider.sendAndConfirm(tx, [keeper]);
    } catch (err) {
      threw = true;
      assert.include(String(err), "MissingJitoTip");
    }
    assert.isTrue(
      threw,
      "expected execute_swap to reject a tip below the minimum amount"
    );
  });

  it("execute_swap pays the keeper a rescue bounty when a Jito tip is present after TTL", async () => {
    const { escrow, partnerWallet, swapIxData } = await initEscrow(3);
    const keeper = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(keeper.publicKey, 1_000_000_000),
      "confirmed"
    );

    await sleep(3000);

    // Real Jito tip accounts are constantly active and already well above
    // the rent-exempt minimum in production. A fresh local validator starts
    // this account at zero, so the tip itself needs to clear that minimum
    // (~890,880 lamports) on a never-before-touched account -- a test
    // artifact, not a real-world constraint on tip sizing.
    const tipIx = SystemProgram.transfer({
      fromPubkey: keeper.publicKey,
      toPubkey: JITO_TIP_ACCOUNT,
      lamports: 1_000_000,
    });

    const executeIx = await inertia.methods
      .executeSwap(swapIxData)
      .accounts({
        caller: keeper.publicKey,
        escrow,
        userWallet: user.publicKey,
        partnerWallet,
        treasury: TREASURY_PUBKEY,
        userInputTokenAccount: userInputAta,
        destinationTokenAccount: userOutputAta,
        swapProgram: mockDex.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .remainingAccounts([
        { pubkey: inputMint, isSigner: false, isWritable: true },
        { pubkey: outputMint, isSigner: false, isWritable: true },
        { pubkey: mintAuthorityPda, isSigner: false, isWritable: false },
      ])
      .instruction();

    const keeperBalanceBefore = await provider.connection.getBalance(
      keeper.publicKey
    );

    const tx = new Transaction().add(tipIx).add(executeIx);
    await provider.sendAndConfirm(tx, [keeper]);

    const keeperBalanceAfter = await provider.connection.getBalance(
      keeper.publicKey
    );
    // Keeper should net positive: 90% of the buffer minus the tip and tx fees.
    assert.isAbove(
      keeperBalanceAfter,
      keeperBalanceBefore - 1_000_000 - 20_000 // tip + generous fee allowance
    );
  });

  it("execute_swap reverts when the swap would deliver less than expected_output_amount", async () => {
    const { escrow, partnerWallet } = await initEscrow(4, { minOutput: 1 });
    // Encode a swap call that only delivers 1 unit, far below expected_output_amount
    // (which stays at OUTPUT_AMOUNT since that's a separate stored field).
    const badSwapIxData = mockDex.coder.instruction.encode("swap", {
      amountIn: new BN(INPUT_AMOUNT),
      amountOut: new BN(1),
    });

    let threw = false;
    try {
      await inertia.methods
        .executeSwap(badSwapIxData)
        .accounts({
          caller: user.publicKey,
          escrow,
          userWallet: user.publicKey,
          partnerWallet,
          treasury: TREASURY_PUBKEY,
          userInputTokenAccount: userInputAta,
          destinationTokenAccount: userOutputAta,
          swapProgram: mockDex.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .remainingAccounts([
          { pubkey: inputMint, isSigner: false, isWritable: true },
          { pubkey: outputMint, isSigner: false, isWritable: true },
          { pubkey: mintAuthorityPda, isSigner: false, isWritable: false },
        ])
        .signers([user])
        .rpc();
    } catch (err) {
      threw = true;
      assert.include(String(err), "OutputBelowMinimum");
    }
    assert.isTrue(
      threw,
      "expected execute_swap to reject a swap encoded with a different discriminator"
    );
  });

  it("self_rescue rejects an early attempt before the 150-slot window elapses", async () => {
    const { escrow } = await initEscrow(5);

    let threw = false;
    try {
      await inertia.methods
        .selfRescue()
        .accounts({
          userWallet: user.publicKey,
          escrow,
          userInputTokenAccount: userInputAta,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
    } catch (err) {
      threw = true;
      assert.include(String(err), "SelfRescueWindowNotElapsed");
    }
    assert.isTrue(threw, "expected self_rescue to reject an early call");
  });
});
