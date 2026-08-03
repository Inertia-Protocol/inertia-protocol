// Plain data only -- no node:fs / marked imports here, so client components
// (the sidebar's active-link highlighting) can import this list without
// pulling server-only file-reading code into the browser bundle.
export interface DocPage {
  slug: string;
  title: string;
  sourcePath: string;
}

export const DOC_PAGES: DocPage[] = [
  { slug: "", title: "Overview", sourcePath: "README.md" },
  { slug: "instructions", title: "Instructions", sourcePath: "docs/INSTRUCTIONS.md" },
  { slug: "integration-guide", title: "Integration Guide", sourcePath: "docs/INTEGRATION_GUIDE.md" },
  { slug: "risk-register", title: "Risk Register", sourcePath: "docs/RISK_REGISTER.md" },
];
