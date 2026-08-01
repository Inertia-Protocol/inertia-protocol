import RescueHero from "./components/RescueHero";

const stats = [
  { value: "100,000", label: "fuzz iterations" },
  { value: "0", label: "assertion panics" },
  { value: "8/8", label: "integration tests" },
  { value: "2", label: "real bugs found and fixed" },
];

export default function Home() {
  return (
    <div style={{ minHeight: "100vh" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          maxWidth: 960,
          margin: "0 auto",
          padding: "28px 24px",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-serif)",
            fontWeight: 800,
            fontSize: 22,
          }}
        >
          N
        </div>
        <a
          href="https://github.com/Inertia-Protocol/inertia-protocol"
          style={{ fontSize: 14, color: "var(--text-secondary)" }}
        >
          GitHub ↗
        </a>
      </header>

      <main
        style={{
          maxWidth: 960,
          margin: "0 auto",
          padding: "48px 24px 96px",
        }}
      >
        <section
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            textAlign: "center",
            padding: "48px 0 80px",
          }}
        >
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 700,
              fontSize: "clamp(32px, 6vw, 56px)",
              lineHeight: 1.1,
              maxWidth: 640,
              marginBottom: 20,
            }}
          >
            Stalled swaps don&rsquo;t have to stay stalled.
          </h1>
          <p
            style={{
              color: "var(--text-secondary)",
              fontSize: 17,
              maxWidth: 520,
              marginBottom: 56,
            }}
          >
            Inertia Protocol rescues swaps that fail to land, before they turn
            into a bad fill. Watch it happen below, this is the real
            mechanism, not an illustration.
          </p>

          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "40px 32px",
              border: "1px solid var(--border)",
              width: "100%",
            }}
          >
            <RescueHero />
          </div>
        </section>

        <section
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
            gap: 1,
            background: "var(--border)",
            marginBottom: 96,
          }}
        >
          {stats.map((s) => (
            <div
              key={s.label}
              style={{
                background: "var(--bg)",
                padding: "28px 20px",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--font-serif)",
                  fontSize: 28,
                  fontWeight: 700,
                  color: "var(--accent)",
                  marginBottom: 4,
                }}
              >
                {s.value}
              </div>
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
                {s.label}
              </div>
            </div>
          ))}
        </section>

        <section style={{ marginBottom: 96 }}>
          <h2
            style={{
              fontFamily: "var(--font-serif)",
              fontSize: 26,
              fontWeight: 700,
              marginBottom: 32,
            }}
          >
            How it works
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 32,
            }}
          >
            {[
              {
                n: "01",
                title: "Delegate, don't deposit",
                body: "A user deposits a small gas buffer and delegates limited spending authority over their input tokens. The tokens never leave their wallet.",
              },
              {
                n: "02",
                title: "Time decides the outcome",
                body: "One permissionless instruction branches purely on elapsed slots. No off-chain claims are trusted, ever.",
              },
              {
                n: "03",
                title: "Rescue, or reclaim",
                body: "If the swap lands quickly, the user gets their full buffer back. If it stalls, a keeper can rescue it for a bounty. If nobody acts, the user reclaims everything themselves.",
              },
            ].map((step) => (
              <div key={step.n}>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 13,
                    color: "var(--accent)",
                    marginBottom: 12,
                  }}
                >
                  {step.n}
                </div>
                <h3
                  style={{
                    fontSize: 16,
                    fontWeight: 600,
                    marginBottom: 8,
                  }}
                >
                  {step.title}
                </h3>
                <p style={{ fontSize: 14, color: "var(--text-secondary)" }}>
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer
        style={{
          borderTop: "1px solid var(--border)",
          padding: "32px 24px",
        }}
      >
        <div
          style={{
            maxWidth: 960,
            margin: "0 auto",
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 16,
            fontSize: 13,
            color: "var(--text-muted)",
          }}
        >
          <span>Inertia Protocol. Early development, not yet deployed.</span>
          <a
            href="https://github.com/Inertia-Protocol/inertia-protocol"
            style={{ color: "var(--text-secondary)" }}
          >
            GitHub ↗
          </a>
        </div>
      </footer>
    </div>
  );
}
