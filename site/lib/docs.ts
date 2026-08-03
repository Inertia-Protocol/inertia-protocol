import { readFileSync } from "node:fs";
import path from "node:path";
import { Marked } from "marked";
import { DOC_PAGES, type DocPage } from "./docsList";

// Real markdown lives in the repo's own docs/ directory and root README --
// rendered from there directly rather than duplicated into this site, so
// there is exactly one source of truth and it can never go stale relative
// to the actual protocol.
const REPO_ROOT = path.join(process.cwd(), "..");

export { DOC_PAGES, type DocPage };

// Keyed by each page's full repo-relative source path (not just basename --
// README.md exists at both the repo root and inside packages/sdk/, and only
// the root one is a rendered page here).
const SLUG_BY_SOURCE = new Map(DOC_PAGES.map((p) => [p.sourcePath, p.slug]));
const GITHUB_BASE = "https://github.com/Inertia-Protocol/inertia-protocol/blob/master/";

// Markdown link targets are real repo-relative paths (../README.md,
// ./RISK_REGISTER.md, ../packages/sdk/src/orcaSwap.ts) or in-page anchors --
// resolved here, relative to the *current page's own source directory* via
// POSIX path resolution (not string-stripped), so they land on this site's
// /docs/* routes when the target is one of the four rendered pages, and on
// the real GitHub repo (at the correct path) otherwise.
function resolveHref(href: string, currentSourceDir: string): string {
  if (/^https?:\/\//.test(href)) return href;
  if (href.startsWith("#")) return href;

  const [rawPath, hash] = href.split("#");
  const repoRelative = path.posix.normalize(path.posix.join(currentSourceDir, rawPath));

  if (SLUG_BY_SOURCE.has(repoRelative)) {
    const slug = SLUG_BY_SOURCE.get(repoRelative)!;
    const base = slug ? `/docs/${slug}` : "/docs";
    return hash ? `${base}#${hash}` : base;
  }
  return `${GITHUB_BASE}${repoRelative}${hash ? `#${hash}` : ""}`;
}

function buildMarked(currentSourceDir: string): Marked {
  // A fresh instance per doc, closed over that doc's own directory -- rather
  // than one shared global renderer -- since link resolution genuinely
  // depends on which file is currently being rendered.
  return new Marked({
    gfm: true,
    renderer: {
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const resolved = resolveHref(href, currentSourceDir);
        const external = /^https?:\/\//.test(resolved);
        const titleAttr = title ? ` title="${title}"` : "";
        const externalAttrs = external ? ' target="_blank" rel="noopener noreferrer"' : "";
        return `<a href="${resolved}"${titleAttr}${externalAttrs}>${text}</a>`;
      },
      // Regular (non-arrow) methods, per marked's own documented extension
      // pattern -- marked binds `this` (including `this.parser`) when it
      // invokes these, which only works with a real function `this`, not an
      // arrow function's captured lexical scope.
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const slug = text
          .replace(/<[^>]+>/g, "")
          .toLowerCase()
          .trim()
          .replace(/[^\w\s-]/g, "")
          .replace(/\s+/g, "-");
        return `<h${depth} id="${slug}">${text}</h${depth}>`;
      },
    },
  });
}

export function loadDoc(page: DocPage): { html: string; title: string } {
  const raw = readFileSync(path.join(REPO_ROOT, page.sourcePath), "utf8");
  const html = buildMarked(path.posix.dirname(page.sourcePath)).parse(raw, { async: false });
  return { html, title: page.title };
}
