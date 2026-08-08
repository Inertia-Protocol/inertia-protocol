"use client";

import { useState, useCallback, useRef } from "react";
import Link from "next/link";
import Mark from "../components/Mark";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";

const EXPLORER = "https://explorer.solana.com";
const RPC_URL = "https://api.devnet.solana.com";
const INERTIA_PROGRAM_ID = new PublicKey("8ST3LRU5gv8ijZehvXdwRzc6VnvqbVozCCdFzEzqhqbW");
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
// Same real, live, high-liquidity devnet pool every other proof in this repo uses.
const OUTPUT_MINT = new PublicKey("9Z8PQAgh6paeYZdHfrBBsfaj4AeqNJWS8H1G19nTBB94");
const WHIRLPOOL_SWAP_DISCRIMINATOR = Uint8Array.from([248, 198, 158, 145, 225, 117, 135, 200]);
const INITIALIZE_ESCROW_DISCRIMINATOR = Uint8Array.from([243, 160, 77, 153, 11, 92, 48, 209]);
const ESCROW_SEED = new TextEncoder().encode("escrow");

const SWAP_AMOUNT_LAMPORTS = BigInt(5_000_000); // 0.005 SOL, matching the repo's own activity generator
const BUFFER_LAMPORTS = BigInt(40_000_000); // 0.04 SOL, matching BUFFER_LAMPORTS in the integration suite
const TOKEN_ACCOUNT_RENT_LAMPORTS = BigInt(2_039_280);
const MIN_SOL_NEEDED_LAMPORTS = BUFFER_LAMPORTS + TOKEN_ACCOUNT_RENT_LAMPORTS + SWAP_AMOUNT_LAMPORTS + BigInt(20_000);

const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 40; // ~2 minutes

// Plain Uint8Array/DataView rather than the Node `Buffer` polyfill -- this
// runs in an arbitrary visitor's browser, and Turbopack's injected Buffer
// shim here is missing writeBigUInt64LE specifically (confirmed live: "e
// .writeBigUInt64LE is not a function" on the deployed demo). Same lesson
// as RescueCounter.tsx: native browser primitives, no bundler-dependent
// polyfill in the critical path.
function u64LE(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

// @solana/web3.js types TransactionInstruction.data as Buffer specifically,
// but only ever reads it as byte data during serialization -- a plain
// Uint8Array is safe here and avoids depending on the Buffer polyfill at all.
function asInstructionData(bytes: Uint8Array): Buffer {
  return bytes as unknown as Buffer;
}

function splInitializeAccountIx(account: PublicKey, mint: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: asInstructionData(Uint8Array.from([1])),
  });
}

function splSyncNativeIx(account: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: account, isSigner: false, isWritable: true }],
    data: asInstructionData(Uint8Array.from([17])),
  });
}

function ataCreateIdempotentIx(payer: PublicKey, ata: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: asInstructionData(Uint8Array.from([1])),
  });
}

function findAssociatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  const [addr] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return addr;
}

function buildInitializeEscrowIx(params: {
  userWallet: PublicKey;
  userInputTokenAccount: PublicKey;
  expectedDestinationTokenAccount: PublicKey;
  escrow: PublicKey;
  nonce: bigint;
}): TransactionInstruction {
  const data = concatBytes([
    INITIALIZE_ESCROW_DISCRIMINATOR,
    u64LE(params.nonce),
    u64LE(BUFFER_LAMPORTS),
    u64LE(BUFFER_LAMPORTS), // dynamic_minimum_lamports -- same value, no adversarial check per the contract's own design
    params.userWallet.toBuffer(), // partner_wallet -- no real integrating platform in this demo, so the visitor's own wallet
    u64LE(SWAP_AMOUNT_LAMPORTS),
    ORCA_WHIRLPOOL_PROGRAM_ID.toBuffer(),
    WHIRLPOOL_SWAP_DISCRIMINATOR,
    u64LE(BigInt(1)), // expected_output_amount -- minimal floor, matching the repo's own activity generator
  ]);

  return new TransactionInstruction({
    programId: INERTIA_PROGRAM_ID,
    keys: [
      { pubkey: params.userWallet, isSigner: true, isWritable: true },
      { pubkey: params.userInputTokenAccount, isSigner: false, isWritable: true },
      { pubkey: params.expectedDestinationTokenAccount, isSigner: false, isWritable: false },
      { pubkey: params.escrow, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: asInstructionData(data),
  });
}

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey: { toBytes(): Uint8Array } | null;
  connect(): Promise<{ publicKey: { toBytes(): Uint8Array } }>;
  signTransaction(tx: Transaction): Promise<Transaction>;
}

function getPhantom(): PhantomProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { solana?: PhantomProvider };
  return w.solana?.isPhantom ? w.solana : null;
}

type DemoState =
  | { phase: "idle" }
  | { phase: "no-wallet" }
  | { phase: "connecting" }
  | { phase: "needs-sol"; wallet: string; balance: number }
  | { phase: "airdropping"; wallet: string }
  | { phase: "creating" }
  | { phase: "pending"; escrow: string; signature: string }
  | { phase: "resolved"; escrow: string; signature: string; resolutionSignature: string | null }
  | { phase: "error"; message: string };

export default function DemoPage() {
  const [state, setState] = useState<DemoState>({ phase: "idle" });
  const pollCount = useRef(0);
  const connectionRef = useRef<Connection | null>(null);

  const getConnection = () => {
    if (!connectionRef.current) connectionRef.current = new Connection(RPC_URL, "confirmed");
    return connectionRef.current;
  };

  const pollStatus = useCallback((escrow: PublicKey, signature: string) => {
    pollCount.current = 0;
    const connection = getConnection();
    const tick = async () => {
      pollCount.current += 1;
      try {
        const info = await connection.getAccountInfo(escrow);
        if (info === null) {
          const sigs = await connection.getSignaturesForAddress(escrow, { limit: 5 });
          setState({
            phase: "resolved",
            escrow: escrow.toBase58(),
            signature,
            resolutionSignature: sigs.length > 0 ? sigs[0].signature : null,
          });
          return;
        }
      } catch {
        // transient RPC hiccup -- keep polling rather than surfacing every blip
      }
      if (pollCount.current < MAX_POLLS) {
        setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    setTimeout(tick, POLL_INTERVAL_MS);
  }, []);

  const createEscrow = useCallback(async (walletPubkey: PublicKey) => {
    const phantom = getPhantom();
    if (!phantom) {
      setState({ phase: "no-wallet" });
      return;
    }
    setState({ phase: "creating" });
    try {
      const connection = getConnection();
      const inputAccount = Keypair.generate();
      const destAta = findAssociatedTokenAddress(walletPubkey, OUTPUT_MINT);
      const nonce = BigInt(Date.now()) * BigInt(1000) + BigInt(Math.floor(Math.random() * 1000));
      const [escrow] = PublicKey.findProgramAddressSync(
        [ESCROW_SEED, walletPubkey.toBuffer(), u64LE(nonce)],
        INERTIA_PROGRAM_ID
      );

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const tx = new Transaction({ feePayer: walletPubkey, blockhash, lastValidBlockHeight });
      tx.add(
        SystemProgram.createAccount({
          fromPubkey: walletPubkey,
          newAccountPubkey: inputAccount.publicKey,
          lamports: Number(TOKEN_ACCOUNT_RENT_LAMPORTS),
          space: 165,
          programId: TOKEN_PROGRAM_ID,
        }),
        splInitializeAccountIx(inputAccount.publicKey, NATIVE_MINT, walletPubkey),
        SystemProgram.transfer({
          fromPubkey: walletPubkey,
          toPubkey: inputAccount.publicKey,
          lamports: Number(SWAP_AMOUNT_LAMPORTS),
        }),
        splSyncNativeIx(inputAccount.publicKey),
        ataCreateIdempotentIx(walletPubkey, destAta, walletPubkey, OUTPUT_MINT),
        buildInitializeEscrowIx({
          userWallet: walletPubkey,
          userInputTokenAccount: inputAccount.publicKey,
          expectedDestinationTokenAccount: destAta,
          escrow,
          nonce,
        })
      );
      // The fresh input token account signs for its own creation locally;
      // the wallet extension supplies the user's own signature afterward --
      // Phantom accepts and preserves a transaction that already carries
      // one partial signature.
      tx.partialSign(inputAccount);
      const signedTx = await phantom.signTransaction(tx);

      const signature = await connection.sendRawTransaction(signedTx.serialize());
      await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");

      setState({ phase: "pending", escrow: escrow.toBase58(), signature });
      pollStatus(escrow, signature);
    } catch (err) {
      setState({ phase: "error", message: err instanceof Error ? err.message : "Transaction failed" });
    }
  }, [pollStatus]);

  const connectWallet = useCallback(async () => {
    const phantom = getPhantom();
    if (!phantom) {
      setState({ phase: "no-wallet" });
      return;
    }
    setState({ phase: "connecting" });
    try {
      const resp = await phantom.connect();
      const pubkey = new PublicKey(resp.publicKey.toBytes());
      const connection = getConnection();
      const balance = await connection.getBalance(pubkey);
      if (BigInt(balance) < MIN_SOL_NEEDED_LAMPORTS) {
        setState({ phase: "needs-sol", wallet: pubkey.toBase58(), balance: balance / 1e9 });
        return;
      }
      await createEscrow(pubkey);
    } catch (err) {
      setState({ phase: "error", message: err instanceof Error ? err.message : "Wallet connection failed" });
    }
  }, [createEscrow]);

  const requestAirdrop = useCallback(async (walletStr: string) => {
    setState({ phase: "airdropping", wallet: walletStr });
    try {
      const connection = getConnection();
      const pubkey = new PublicKey(walletStr);
      const sig = await connection.requestAirdrop(pubkey, 1_000_000_000); // 1 devnet SOL, free and worthless
      await connection.confirmTransaction(sig, "confirmed");
      await createEscrow(pubkey);
    } catch (err) {
      setState({
        phase: "error",
        message:
          "Devnet faucet request failed (it rate-limits aggressively). Try a public devnet faucet website, then reload and connect again.",
      });
      void err;
    }
  }, [createEscrow]);

  return (
    <div className="demo-page">
      <header className="docs-header">
        <div className="wrap docs-header-inner">
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Mark size={22} idPrefix="demo-hdr" />
            <span className="wordmark" style={{ fontSize: 16 }}>
              INERTIA
            </span>
          </Link>
          <Link href="/" className="navlink">
            &larr; Back
          </Link>
        </div>
      </header>

      <main className="demo-main wrap">
        <div className="eyebrow" style={{ marginBottom: 14 }}>
          Live on devnet
        </div>
        <h1 className="demo-title">Trigger a real rescue yourself.</h1>
        <p className="demo-lede">
          Connect a devnet wallet and this creates a real escrow &mdash; your
          own real gas buffer, your own real token delegation &mdash; then
          deliberately leaves it unexecuted, exactly like this repo&apos;s
          own activity generator does. Two independent keeper bots are
          already running, continuously, watching for exactly this. Nothing
          is staged: you&apos;re watching the same permissionless race
          described in the docs happen live, over your own escrow, signed by
          your own wallet.
        </p>

        <div className="proof-status" style={{ marginBottom: 32 }}>
          <div className="proof-status-row">
            <span className="proof-status-label">Requires</span>
            <span>
              Phantom wallet, set to Devnet, with a small amount of devnet
              SOL (the demo can request some for you if you have none)
            </span>
          </div>
        </div>

        <div className="demo-panel">
          {state.phase === "idle" && (
            <button className="btn" onClick={connectWallet}>
              Connect Phantom &amp; create a real escrow
            </button>
          )}

          {state.phase === "no-wallet" && (
            <div className="demo-status demo-status-error">
              No Phantom wallet detected. Install it from{" "}
              <a href="https://phantom.app" target="_blank" rel="noopener noreferrer" className="proof-inline-link">
                phantom.app
              </a>
              , switch it to Devnet in Settings &rarr; Developer Settings, then reload this page.
            </div>
          )}

          {state.phase === "connecting" && (
            <div className="demo-status">
              <span className="demo-spinner" aria-hidden="true" />
              Waiting for wallet connection&hellip;
            </div>
          )}

          {state.phase === "needs-sol" && (
            <div className="demo-status" style={{ flexDirection: "column", alignItems: "flex-start", gap: 14 }}>
              <div>
                Connected: <span className="proof-mono">{state.wallet}</span>
                <br />
                Balance: {state.balance.toFixed(4)} SOL &mdash; needs at
                least {(Number(MIN_SOL_NEEDED_LAMPORTS) / 1e9).toFixed(3)} SOL
                on devnet to cover the gas buffer and rent.
              </div>
              <button className="btn" onClick={() => requestAirdrop(state.wallet)}>
                Get devnet SOL &amp; continue
              </button>
            </div>
          )}

          {state.phase === "airdropping" && (
            <div className="demo-status">
              <span className="demo-spinner" aria-hidden="true" />
              Requesting devnet SOL from the faucet&hellip;
            </div>
          )}

          {state.phase === "creating" && (
            <div className="demo-status">
              <span className="demo-spinner" aria-hidden="true" />
              Building and signing the escrow transaction&hellip;
            </div>
          )}

          {state.phase === "error" && (
            <div className="demo-status demo-status-error">
              {state.message}
              <div style={{ marginTop: 16 }}>
                <button className="btn btn-ghost" onClick={() => setState({ phase: "idle" })}>
                  Try again
                </button>
              </div>
            </div>
          )}

          {(state.phase === "pending" || state.phase === "resolved") && (
            <div className="demo-result">
              <div className="demo-result-row">
                <span className="demo-result-label">Escrow created</span>
                <a
                  href={`${EXPLORER}/address/${state.escrow}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="proof-mono"
                >
                  {state.escrow}
                </a>
              </div>
              <div className="demo-result-row">
                <span className="demo-result-label">Creation tx</span>
                <a
                  href={`${EXPLORER}/tx/${state.signature}?cluster=devnet`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="proof-mono"
                >
                  {state.signature.slice(0, 24)}&hellip;
                </a>
              </div>

              {state.phase === "pending" && (
                <div className="demo-status" style={{ marginTop: 20 }}>
                  <span className="demo-spinner" aria-hidden="true" />
                  Waiting for a keeper to find and rescue it&hellip;
                </div>
              )}

              {state.phase === "resolved" && (
                <>
                  <div className="demo-resolved-banner">Rescued.</div>
                  {state.resolutionSignature && (
                    <div className="demo-result-row">
                      <span className="demo-result-label">Rescue tx</span>
                      <a
                        href={`${EXPLORER}/tx/${state.resolutionSignature}?cluster=devnet`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="proof-mono"
                      >
                        {state.resolutionSignature.slice(0, 24)}&hellip;
                      </a>
                    </div>
                  )}
                  <button className="btn btn-ghost" style={{ marginTop: 20 }} onClick={() => setState({ phase: "idle" })}>
                    Do it again
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <p className="demo-honesty">
          This is real, not staged: a real devnet transaction, signed by
          your own wallet, and real keeper bots that don&apos;t know this
          escrow came from a human. What it doesn&apos;t do is simulate a
          swap that actually stalled &mdash; you can&apos;t force that on
          demand &mdash; so instead the demo creates the escrow and simply
          never attempts the swap, which is the identical on-chain state a
          genuinely stalled one would be in. See{" "}
          <Link href="/docs/worked-examples" className="proof-inline-link">
            Worked Examples
          </Link>{" "}
          for the same flow explained in code.
        </p>
      </main>
    </div>
  );
}
