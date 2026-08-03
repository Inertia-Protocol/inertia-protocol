import { DOC_PAGES, loadDoc } from "@/lib/docs";

export default function RiskRegisterPage() {
  const { html } = loadDoc(DOC_PAGES.find((p) => p.slug === "risk-register")!);
  return <div dangerouslySetInnerHTML={{ __html: html }} />;
}
