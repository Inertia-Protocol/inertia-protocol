import Mark from "./components/Mark";

const GITHUB_URL = "https://github.com/Inertia-Protocol/inertia-protocol";
const DOCS_URL = "/docs";

export default function Home() {
  return (
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
        <a href={DOCS_URL} className="btn">
          View Docs
        </a>
      </main>

      <footer className="footnote">Early development. Not yet deployed.</footer>
    </div>
  );
}
