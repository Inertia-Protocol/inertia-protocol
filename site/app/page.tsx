import RescueHero from "./components/RescueHero";
import Logo from "./components/Logo";

const stats = [
  { value: "100,000", label: "Fuzz iterations" },
  { value: "0", label: "Assertion panics" },
  { value: "8/8", label: "Integration tests" },
  { value: "2", label: "Real bugs found and fixed" },
];

const steps = [
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
    body: "A fast landing refunds the user in full. A stalled one lets a keeper rescue it for a bounty. If nobody acts, the user reclaims it themselves.",
  },
];

export default function Home() {
  return (
    <div>
      <header className="wrap" style={{ paddingTop: 28, paddingBottom: 28 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Logo size={24} />
          <a href="https://github.com/Inertia-Protocol/inertia-protocol" className="eyebrow">
            GitHub &#8599;
          </a>
        </div>
      </header>
      <hr className="hairline" />

      <main>
        <section className="wrap" style={{ paddingTop: 96, paddingBottom: 96 }}>
          <p className="eyebrow" style={{ marginBottom: 20 }}>
            A Solana program
          </p>
          <h1
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 600,
              fontSize: "clamp(36px, 6vw, 68px)",
              lineHeight: 1.05,
              letterSpacing: "-0.01em",
              maxWidth: 760,
              marginBottom: 24,
            }}
          >
            Stalled swaps don&rsquo;t have to <em style={{ color: "var(--accent)", fontStyle: "normal" }}>stay</em> stalled.
          </h1>
          <p
            style={{
              color: "var(--text-secondary)",
              fontSize: 18,
              maxWidth: 480,
              marginBottom: 72,
            }}
          >
            Inertia rescues swaps that fail to land, before they turn into a
            bad fill. What&rsquo;s below is the real mechanism, running live,
            not an illustration of it.
          </p>

          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: "56px var(--edge)",
              background: "var(--surface)",
              border: "1px solid var(--border)",
            }}
          >
            <RescueHero />
          </div>
        </section>

        <hr className="hairline" />

        <section className="wrap" style={{ paddingTop: 64, paddingBottom: 64 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
              gap: 40,
            }}
          >
            {stats.map((s) => (
              <div key={s.label}>
                <div
                  style={{
                    fontFamily: "var(--font-serif)",
                    fontWeight: 600,
                    fontSize: 34,
                    color: "var(--text-primary)",
                    marginBottom: 6,
                  }}
                >
                  {s.value}
                </div>
                <div className="eyebrow">{s.label}</div>
              </div>
            ))}
          </div>
        </section>

        <hr className="hairline" />

        <section className="wrap" style={{ paddingTop: 96, paddingBottom: 96 }}>
          <h2
            style={{
              fontFamily: "var(--font-serif)",
              fontWeight: 600,
              fontSize: 32,
              marginBottom: 64,
            }}
          >
            How it works
          </h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
              gap: 56,
            }}
          >
            {steps.map((step) => (
              <div key={step.n}>
                <div
                  style={{
                    fontFamily: "var(--font-serif)",
                    fontSize: 22,
                    color: "var(--accent)",
                    marginBottom: 20,
                  }}
                >
                  {step.n}
                </div>
                <h3
                  style={{
                    fontSize: 17,
                    fontWeight: 500,
                    marginBottom: 10,
                  }}
                >
                  {step.title}
                </h3>
                <p style={{ fontSize: 15, color: "var(--text-secondary)", lineHeight: 1.65 }}>
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </section>
      </main>

      <hr className="hairline" />

      <footer className="wrap" style={{ paddingTop: 28, paddingBottom: 28 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 12,
          }}
        >
          <span className="eyebrow">Early development. Not yet deployed.</span>
          <a href="https://github.com/Inertia-Protocol/inertia-protocol" className="eyebrow">
            GitHub &#8599;
          </a>
        </div>
      </footer>
    </div>
  );
}
