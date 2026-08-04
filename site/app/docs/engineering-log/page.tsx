import { DOC_PAGES, loadDoc } from "@/lib/docs";
import DocPage from "../components/DocPage";

export default function EngineeringLogPage() {
  const doc = loadDoc(DOC_PAGES.find((p) => p.slug === "engineering-log")!);
  return <DocPage html={doc.html} headings={doc.headings} />;
}
