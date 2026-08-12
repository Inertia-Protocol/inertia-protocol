import { DOC_PAGES, loadDoc } from "@/lib/docs";
import DocPage from "../components/DocPage";

export default function SolanaTransactionFailedPage() {
  const doc = loadDoc(DOC_PAGES.find((p) => p.slug === "solana-transaction-failed")!);
  return <DocPage html={doc.html} headings={doc.headings} />;
}
