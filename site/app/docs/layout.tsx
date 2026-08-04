import Link from "next/link";
import type { Metadata } from "next";
import Mark from "../components/Mark";
import DocsSidebar from "./components/DocsSidebar";

const GITHUB_URL = "https://github.com/Inertia-Protocol/inertia-protocol";

export const metadata: Metadata = {
  title: "Docs — Inertia Protocol",
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="docs-shell">
      <header className="docs-header">
        <div className="wrap docs-header-inner">
          <Link href="/" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Mark size={22} idPrefix="docs-hdr" />
            <span className="wordmark" style={{ fontSize: 16 }}>
              INERTIA
            </span>
          </Link>
          <a href={GITHUB_URL} className="navlink">
            GitHub
          </a>
        </div>
      </header>

      <div className="wrap docs-layout">
        <DocsSidebar />
        <main className="docs-main">{children}</main>
      </div>
    </div>
  );
}
