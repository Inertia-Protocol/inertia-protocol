"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { DOC_PAGES } from "@/lib/docsList";

export default function DocsSidebar() {
  const pathname = usePathname();

  return (
    <nav className="docs-sidebar" aria-label="Documentation">
      {DOC_PAGES.map((page) => {
        const href = page.slug ? `/docs/${page.slug}` : "/docs";
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            className={active ? "docs-sidebar-link active" : "docs-sidebar-link"}
          >
            {page.title}
          </Link>
        );
      })}
    </nav>
  );
}
