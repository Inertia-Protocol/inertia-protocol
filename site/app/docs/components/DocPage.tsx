import type { Heading } from "@/lib/docs";
import TocRail from "./TocRail";

export default function DocPage({ html, headings }: { html: string; headings: Heading[] }) {
  return (
    <div className="docs-page-inner">
      <article className="docs-content" dangerouslySetInnerHTML={{ __html: html }} />
      <TocRail headings={headings} />
    </div>
  );
}
