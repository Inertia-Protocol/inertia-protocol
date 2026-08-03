import { DOC_PAGES, loadDoc } from "@/lib/docs";

export default function InstructionsPage() {
  const { html } = loadDoc(DOC_PAGES.find((p) => p.slug === "instructions")!);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
