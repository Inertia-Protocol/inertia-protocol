import { DOC_PAGES, loadDoc } from "@/lib/docs";
import DocPage from "./components/DocPage";

export default function DocsOverviewPage() {
  const doc = loadDoc(DOC_PAGES[0]);
  return <DocPage html={doc.html} headings={doc.headings} />;
}
