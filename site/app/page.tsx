import Mark from "./components/Mark";

const GITHUB_URL = "https://github.com/Inertia-Protocol/inertia-protocol";
const DOCS_URL = "/docs";
const PROGRAM_ID = "8ST3LRU5gv8ijZehvXdwRzc6VnvqbVozCCdFzEzqhqbW";
const EXPLORER = "https://explorer.solana.com";

const PROOFS = [
  {
    label: "Orca Whirlpools rescue",
    detail: "Concentrated liquidity -- externally built and audited, real devnet pool",
    tx: "2ZxxnPvbWwZHAev7JHgTPDbmMMvyXgWqHtDeubHyD5nRk36sDmSG73FSpvYcit7KZhFUkCpX5pTyLP8dvhH4dhPT",
  },
  {
    label: "Raydium CPMM rescue",
    detail: "Constant product -- against a pool created with its own real liquidity",
    tx: "aL3g4XTGGfKbEdaaVoX1W982ej5qCrv9mPPD8yFWSprMh6fQoKk7yAvLH4wdM5yfL5c8FiEZtUS8hANH5TiXR1p",
  },
  {
    label: "Meteora DLMM rescue",
    detail: "Discrete-bin liquidity -- a genuinely different model from the other two",
    tx: "AKMPPdey6CSrzCMvqCsN9BDCk3Vn7SFF9kXZ1BQVacVRauBmSeyGNjKtEGSNmR7WWXtBYWCi6wTgWGQyc2cP4xd",
  },
  {
    label: "Concurrent keeper race, won cleanly",
    detail: "Two independent keepers racing the same escrow -- one winner, zero double-spends",
    tx: "35xZnY8busagAJ28JoAstDZBMBtnxZx4S1hbEVcVsHi87DgMwfxbGAipzxyz1kcyqnprSEbmiSHYMtewW6Qh2gbN",
  },
];

export default function Home() {
  return (
    <>
      <div className="landing">
        <header className="landing-header">
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <Mark size={30} idPrefix="hdr" />
            <span className="wordmark">INERTIA</span>
          </div>
          <nav className="nav">
            <a href={GITHUB_URL} className="navlink">
              GitHub
            </a>
            <a href={DOCS_URL} className="navlink">
              Docs
            </a>
          </nav>
        </header>

        <main className="landing-main">
          <div style={{ marginBottom: 34 }}>
            <Mark size={148} idPrefix="hero" />
          </div>
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 600,
              fontSize: "clamp(40px, 5.4vw, 64px)",
              lineHeight: 1.1,
              letterSpacing: "-0.01em",
              marginBottom: 18,
            }}
          >
            Stall recovery, on chain.
          </h1>
          <p
            style={{
              color: "var(--text-secondary)",
              fontSize: 16,
              lineHeight: 1.7,
              maxWidth: 470,
              marginBottom: 44,
            }}
          >
            When a swap fails to land, Inertia executes it on chain through a
            permissionless keeper, or returns everything to you.
          </p>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
            <a href={DOCS_URL} className="btn">
              View Docs
            </a>
            <a href="#proof" className="btn btn-ghost">
              See it live
            </a>
          </div>

          <a href="#proof" className="hero-status">
            <span className="hero-status-dot" aria-hidden="true" />
            <span>
              Live on devnet &middot; real rescues against Orca, Raydium &amp;
              Meteora &middot; continuous keepers running
            </span>
            <span className="hero-status-id">
              {PROGRAM_ID.slice(0, 4)}&hellip;{PROGRAM_ID.slice(-4)}
            </span>
          </a>
        </main>

        <footer className="footnote">
          Live on Solana devnet &middot; unaudited &middot; not yet on mainnet
        </footer>
      </div>

      <section id="proof" className="proof">
        <div className="wrap">
          <div className="eyebrow" style={{ marginBottom: 14 }}>
            Live on devnet
          </div>
          <h2 className="proof-title">Real rescues, on a real network, right now.</h2>
          <p className="proof-lede">
            Proven against three independently-built DEXes with genuinely
            different liquidity models &mdash; Orca Whirlpools, Raydium CPMM, and
            Meteora DLMM &mdash; every rescue a real on-chain transaction anyone
            can verify. A continuous activity generator and two independently-keyed
            keeper bots have been running unattended, racing each other over live
            escrows.
          </p>

          <div className="proof-status">
            <div className="proof-status-row">
              <span className="proof-status-label">Program</span>
              <a
                href={`${EXPLORER}/address/${PROGRAM_ID}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="proof-mono"
              >
                {PROGRAM_ID}
              </a>
            </div>
            <div className="proof-status-row">
              <span className="proof-status-label">Status</span>
              <span>
                Live on Solana devnet &middot; continuous keepers running &middot;
                100+ real rescues logged &middot; unaudited, pre-mainnet
              </span>
            </div>
          </div>

          <div className="proof-grid">
            {PROOFS.map((p) => (
              <a
                key={p.tx}
                href={`${EXPLORER}/tx/${p.tx}?cluster=devnet`}
                target="_blank"
                rel="noopener noreferrer"
                className="proof-card"
              >
                <div className="proof-card-label">{p.label}</div>
                <div className="proof-card-detail">{p.detail}</div>
                <div className="proof-mono proof-card-tx">
                  {p.tx.slice(0, 20)}&hellip; &nearr;
                </div>
              </a>
            ))}
          </div>

          <div className="proof-links">
            <a href="/docs/integration-guide" className="btn">
              Integration Guide
            </a>
            <a href="/docs/risk-register" className="btn btn-ghost">
              Risk Register
            </a>
            <a href="/docs/running-a-keeper" className="btn btn-ghost">
              Run a Keeper
            </a>
          </div>

          <p className="proof-honesty">
            Every number and transaction above is real and checkable. What this
            is not yet: audited, on mainnet, or carrying organic third-party
            volume &mdash; the{" "}
            <a href="/docs/risk-register" className="proof-inline-link">
              risk register
            </a>{" "}
            lists every known open item, kept current rather than glossed over.
          </p>
        </div>
      </section>
    </>
  );
}
