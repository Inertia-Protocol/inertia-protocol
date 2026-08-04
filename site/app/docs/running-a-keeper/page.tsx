import { DOC_PAGES, loadDoc } from "@/lib/docs";
import DocPage from "../components/DocPage";

export default function RunningAKeeperPage() {
  const doc = loadDoc(DOC_PAGES.find((p) => p.slug === "running-a-keeper")!);
  return <DocPage html={doc.html} headings={doc.headings} />;
}
