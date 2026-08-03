import { DOC_PAGES, loadDoc } from "@/lib/docs";

export default function IntegrationGuidePage() {
  const { html } = loadDoc(DOC_PAGES.find((p) => p.slug === "integration-guide")!);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
