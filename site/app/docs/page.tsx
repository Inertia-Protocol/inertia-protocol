import { DOC_PAGES, loadDoc } from "@/lib/docs";

export default function DocsOverviewPage() {
  const { html } = loadDoc(DOC_PAGES[0]);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
