import { DOC_PAGES, loadDoc } from "@/lib/docs";
import DocPage from "../components/DocPage";

export default function WhySolanaSwapsFailPage() {
  const doc = loadDoc(DOC_PAGES.find((p) => p.slug === "why-solana-swaps-fail")!);
  return <DocPage html={doc.html} headings={doc.headings} />;
}
