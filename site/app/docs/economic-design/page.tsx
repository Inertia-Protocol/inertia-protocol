import { DOC_PAGES, loadDoc } from "@/lib/docs";
import DocPage from "../components/DocPage";

export default function EconomicDesignPage() {
  const doc = loadDoc(DOC_PAGES.find((p) => p.slug === "economic-design")!);
  return <DocPage html={doc.html} headings={doc.headings} />;
}
