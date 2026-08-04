import { DOC_PAGES, loadDoc } from "@/lib/docs";
import DocPage from "../components/DocPage";

export default function InstructionsPage() {
  const doc = loadDoc(DOC_PAGES.find((p) => p.slug === "instructions")!);
  return <DocPage html={doc.html} headings={doc.headings} />;
}
