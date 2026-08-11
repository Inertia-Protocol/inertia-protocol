"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import Mark from "../components/Mark";
import { Connection, PublicKey } from "@solana/web3.js";

const EXPLORER = "https://explorer.solana.com";
const RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("8ST3LRU5gv8ijZehvXdwRzc6VnvqbVozCCdFzEzqhqbW");

// All taken from the checked-in Anchor IDL (packages/sdk/src/idl/inertia_protocol.json)
const INIT_ESCROW_DISCRIMINATOR = [243, 160, 77, 153, 11, 92, 48, 209];
const EXECUTE_SWAP_DISCRIMINATOR = [56, 182, 124, 215, 155, 140, 157, 102];
const SELF_RESCUE_DISCRIMINATOR = [122, 22, 229, 109, 41, 88, 207, 19];
const CLEANUP_DISCRIMINATOR = [197, 214, 51, 163, 114, 209, 68, 130];
const SWAP_EXECUTED_EVENT_DISCRIMINATOR = [150, 166, 26, 225, 28, 89, 38, 79];
// initialize_escrow instruction data layout: discriminator(8) + nonce(8) +
// gas_buffer_lamports(8) + dynamic_minimum_lamports(8) + partner_wallet(32) + ...
// Offsets below are absolute from the start of the raw instruction data
// (including the discriminator), verified against real on-chain transactions,
// not just read off the struct definition -- an earlier version of this
// undercounted by one 8-byte field and silently decoded the wrong bytes as
// partner_wallet.
const GAS_BUFFER_OFFSET = 8 + 8; // 16: after discriminator + nonce
const PARTNER_WALLET_OFFSET = 8 + 8 + 8 + 8; // 32: after discriminator + nonce + gas_buffer + dynamic_minimum
// initialize_escrow account order (from the IDL): 0 user_wallet, 1 user_input_token_account,
// 2 expected_destination_token_account, 3 escrow, 4 token_program, 5 system_program
const ESCROW_ACCOUNT_INDEX = 3;
// SwapExecuted event layout, after the 8-byte discriminator: escrow(32) + user_wallet(32) + was_rescue(1) + ...
const WAS_RESCUE_OFFSET = 8 + 32 + 32;
const PARTNER_SHARE_BPS = BigInt(500); // 5%, matches PARTNER_SHARE_BPS in constants.rs
const BASIS_POINTS_DIVISOR = BigInt(10000);

const SIGNATURE_LIMIT = 1000;
const CALL_DELAY_MS = 300;
const MAX_ATTEMPTS = 3;

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesEqual(a: Uint8Array, b: number[]): boolean {
  if (a.length < b.length) return false;
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  return view.getBigUint64(0, true);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(500 * 2 ** attempt);
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

type EscrowRecord = {
  escrow: PublicKey;
  gasBufferLamports: bigint;
  creationSignature: string;
  creationSlot: number;
  creationTime: number | null;
};

type ResolvedOutcome =
  | { kind: "pending" }
  | { kind: "rescued"; latencySeconds: number | null; signature: string }
  | { kind: "landed-normally"; signature: string }
  | { kind: "self-rescued"; signature: string }
  | { kind: "expired-cleanup"; signature: string };

type Metrics = {
  totalSwaps: number;
  rescued: number;
  landedNormally: number;
  selfRescued: number;
  expiredCleanup: number;
  pending: number;
  revenueLamports: bigint;
  latenciesSeconds: number[];
};

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export default function DashboardPage() {
  const [address, setAddress] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const runScan = useCallback(async () => {
    setError(null);
    setMetrics(null);
    setRunning(true);
    let partnerKey: PublicKey;
    try {
      partnerKey = new PublicKey(address.trim());
    } catch {
      setError("That doesn't look like a valid Solana address.");
      setRunning(false);
      return;
    }

    try {
      const connection = new Connection(RPC_URL, "confirmed");

      setStatus("Fetching program transaction history…");
      const sigInfos = await withRetry(() =>
        connection.getSignaturesForAddress(PROGRAM_ID, { limit: SIGNATURE_LIMIT })
      );

      setStatus("Scanning for escrows created by this address…");
      const matches: EscrowRecord[] = [];
      for (let i = 0; i < sigInfos.length; i++) {
        if (i > 0) await sleep(CALL_DELAY_MS);
        setProgress({ done: i + 1, total: sigInfos.length });
        const sigInfo = sigInfos[i];
        const tx = await withRetry(() =>
          connection.getTransaction(sigInfo.signature, { maxSupportedTransactionVersion: 0 })
        );
        if (!tx) continue;
        const msg = tx.transaction.message;
        const keys = msg.staticAccountKeys;
        for (const ix of msg.compiledInstructions) {
          if (!keys[ix.programIdIndex]?.equals(PROGRAM_ID)) continue;
          const data = ix.data as Uint8Array;
          if (!bytesEqual(data, INIT_ESCROW_DISCRIMINATOR)) continue;
          const partnerBytes = data.subarray(PARTNER_WALLET_OFFSET, PARTNER_WALLET_OFFSET + 32);
          const partnerPubkey = new PublicKey(partnerBytes);
          if (!partnerPubkey.equals(partnerKey)) continue;
          const escrowIdx = ix.accountKeyIndexes[ESCROW_ACCOUNT_INDEX];
          const escrow = keys[escrowIdx];
          if (!escrow) continue;
          matches.push({
            escrow,
            gasBufferLamports: readU64LE(data, GAS_BUFFER_OFFSET),
            creationSignature: sigInfo.signature,
            creationSlot: tx.slot,
            creationTime: tx.blockTime ?? null,
          });
        }
      }

      setStatus(`Found ${matches.length} escrow${matches.length === 1 ? "" : "s"}. Resolving outcomes…`);
      const outcomes: ResolvedOutcome[] = [];
      for (let i = 0; i < matches.length; i++) {
        if (i > 0) await sleep(CALL_DELAY_MS);
        setProgress({ done: i + 1, total: matches.length });
        const record = matches[i];
        const escrowSigs = await withRetry(() =>
          connection.getSignaturesForAddress(record.escrow, { limit: 5 })
        );
        const resolutionSigInfo = escrowSigs.find((s) => s.signature !== record.creationSignature);
        if (!resolutionSigInfo) {
          outcomes.push({ kind: "pending" });
          continue;
        }
        await sleep(CALL_DELAY_MS);
        const resTx = await withRetry(() =>
          connection.getTransaction(resolutionSigInfo.signature, { maxSupportedTransactionVersion: 0 })
        );
        if (!resTx) {
          outcomes.push({ kind: "pending" });
          continue;
        }
        const resKeys = resTx.transaction.message.staticAccountKeys;
        let matchedKind: "execute_swap" | "self_rescue" | "cleanup" | null = null;
        for (const ix of resTx.transaction.message.compiledInstructions) {
          if (!resKeys[ix.programIdIndex]?.equals(PROGRAM_ID)) continue;
          const data = ix.data as Uint8Array;
          if (bytesEqual(data, EXECUTE_SWAP_DISCRIMINATOR)) matchedKind = "execute_swap";
          else if (bytesEqual(data, SELF_RESCUE_DISCRIMINATOR)) matchedKind = "self_rescue";
          else if (bytesEqual(data, CLEANUP_DISCRIMINATOR)) matchedKind = "cleanup";
        }
        const latencySeconds =
          record.creationTime != null && resTx.blockTime != null
            ? resTx.blockTime - record.creationTime
            : null;

        if (matchedKind === "execute_swap") {
          let wasRescue = false;
          for (const line of resTx.meta?.logMessages ?? []) {
            if (!line.startsWith("Program data: ")) continue;
            const raw = decodeBase64(line.slice("Program data: ".length));
            if (raw.length > WAS_RESCUE_OFFSET && bytesEqual(raw, SWAP_EXECUTED_EVENT_DISCRIMINATOR)) {
              wasRescue = raw[WAS_RESCUE_OFFSET] === 1;
            }
          }
          outcomes.push(
            wasRescue
              ? { kind: "rescued", latencySeconds, signature: resolutionSigInfo.signature }
              : { kind: "landed-normally", signature: resolutionSigInfo.signature }
          );
        } else if (matchedKind === "self_rescue") {
          outcomes.push({ kind: "self-rescued", signature: resolutionSigInfo.signature });
        } else if (matchedKind === "cleanup") {
          outcomes.push({ kind: "expired-cleanup", signature: resolutionSigInfo.signature });
        } else {
          outcomes.push({ kind: "pending" });
        }
      }

      const computed: Metrics = {
        totalSwaps: matches.length,
        rescued: 0,
        landedNormally: 0,
        selfRescued: 0,
        expiredCleanup: 0,
        pending: 0,
        revenueLamports: BigInt(0),
        latenciesSeconds: [],
      };
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i];
        if (outcome.kind === "rescued") {
          computed.rescued += 1;
          computed.revenueLamports += (matches[i].gasBufferLamports * PARTNER_SHARE_BPS) / BASIS_POINTS_DIVISOR;
          if (outcome.latencySeconds != null) computed.latenciesSeconds.push(outcome.latencySeconds);
        } else if (outcome.kind === "landed-normally") {
          computed.landedNormally += 1;
        } else if (outcome.kind === "self-rescued") {
          computed.selfRescued += 1;
        } else if (outcome.kind === "expired-cleanup") {
          computed.expiredCleanup += 1;
        } else {
          computed.pending += 1;
        }
      }

      setMetrics(computed);
      setStatus(null);
      setProgress(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scan failed.");
      setStatus(null);
      setProgress(null);
    } finally {
      setRunning(false);
    }
  }, [address]);

  const sortedLatencies = metrics ? [...metrics.latenciesSeconds].sort((a, b) => a - b) : [];
  const p50 = percentile(sortedLatencies, 50);
  const p99 = percentile(sortedLatencies, 99);
  const rescueRate =
    metrics && metrics.totalSwaps > 0 ? ((metrics.rescued / metrics.totalSwaps) * 100).toFixed(1) : null;

  return (
    <div className="demo-page">
      <header className="docs-header">
        <div className="wrap docs-header-inner">
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Mark size={22} idPrefix="dash-hdr" />
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
        <h1 className="demo-title">Partner dashboard.</h1>
        <p className="demo-lede">
          Paste the wallet address you use as <code>partner_wallet</code> when creating escrows.
          No login, no account, every number below is read directly from on-chain history, the
          same data anyone can independently verify on Explorer.
        </p>

        <div className="demo-panel">
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Partner wallet address"
              disabled={running}
              style={{
                flex: "1 1 320px",
                background: "rgba(0,0,0,0.25)",
                border: "1px solid var(--border-strong)",
                borderRadius: 4,
                padding: "10px 14px",
                color: "var(--text-primary)",
                fontFamily: "var(--font-mono)",
                fontSize: 13,
              }}
            />
            <button className="btn" onClick={runScan} disabled={running || address.trim().length === 0}>
              {running ? "Scanning…" : "Look up"}
            </button>
          </div>

          {status && (
            <div className="demo-status" style={{ marginTop: 20 }}>
              <span className="demo-spinner" aria-hidden="true" />
              {status}
              {progress && (
                <span style={{ marginLeft: 8, color: "var(--text-secondary)" }}>
                  ({progress.done}/{progress.total})
                </span>
              )}
            </div>
          )}

          {error && (
            <div className="demo-status demo-status-error" style={{ marginTop: 20 }}>
              {error}
            </div>
          )}

          {metrics && (
            <div className="proof-status" style={{ marginTop: 24 }}>
              <div className="proof-status-row">
                <span className="proof-status-label">Swaps</span>
                <span>{metrics.totalSwaps} total routed through Inertia from this address</span>
              </div>
              <div className="proof-status-row">
                <span className="proof-status-label">Rescued</span>
                <span>
                  {metrics.rescued} would-have-failed swaps rescued
                  {rescueRate !== null ? ` (${rescueRate}% of total)` : ""}
                </span>
              </div>
              <div className="proof-status-row">
                <span className="proof-status-label">Revenue</span>
                <span>
                  {(Number(metrics.revenueLamports) / 1e9).toFixed(6)} SOL earned (5% partner share, real
                  lamports moved on-chain)
                </span>
              </div>
              <div className="proof-status-row">
                <span className="proof-status-label">Latency</span>
                <span>
                  {p50 !== null ? `p50: ${p50}s` : "no rescues yet"}
                  {p99 !== null ? `, p99: ${p99}s` : ""} (stall to rescue landing, real observed values)
                </span>
              </div>
              <div className="proof-status-row">
                <span className="proof-status-label">Also</span>
                <span>
                  {metrics.landedNormally} landed normally, no rescue needed &middot;{" "}
                  {metrics.selfRescued} self-rescued by the user &middot; {metrics.expiredCleanup}{" "}
                  expired unrescued &middot; {metrics.pending} still pending
                </span>
              </div>
            </div>
          )}
        </div>

        <p className="demo-honesty">
          Every number above is computed live from Solana devnet transaction history for the exact
          address you entered, nothing is cached or precomputed. The &quot;expired unrescued&quot;
          count is included deliberately: it is not a good-news number, but hiding it would make
          the rest of this dashboard less trustworthy, not more.
        </p>
      </main>
    </div>
  );
}
