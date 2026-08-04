import { DOC_PAGES, loadDoc } from "@/lib/docs";
import DocPage from "../components/DocPage";

export default function WorkedExamplesPage() {
  const doc = loadDoc(DOC_PAGES.find((p) => p.slug === "worked-examples")!);
  return <DocPage html={doc.html} headings={doc.headings} />;
}
