"use client";

import { useEffect, useRef, useState } from "react";
import type { Heading } from "@/lib/docs";

const READING_LINE = 110;

export default function TocRail({ headings }: { headings: Heading[] }) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const tickingRef = useRef(false);

  useEffect(() => {
    const elements = headings
      .map((h) => document.getElementById(h.id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    // Active section = the last heading that has scrolled up past the
    // reading line, not whichever heading happens to intersect a narrow
    // band right now -- a heading-intersection approach goes blank for
    // most of a long section's body, between one heading scrolling off
    // and the next arriving.
    function updateActive() {
      let current: string | null = elements[0].id;
      for (const el of elements) {
        if (el.getBoundingClientRect().top <= READING_LINE) {
          current = el.id;
        } else {
          break;
        }
      }
      setActiveId(current);
      tickingRef.current = false;
    }

    function onScroll() {
      if (!tickingRef.current) {
        tickingRef.current = true;
        requestAnimationFrame(updateActive);
      }
    }

    updateActive();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <nav className="docs-toc" aria-label="On this page">
      <div className="docs-toc-label">On this page</div>
      {headings.map((h) => (
        <a
          key={h.id}
          href={`#${h.id}`}
          className={
            "docs-toc-link" +
            (h.depth === 3 ? " depth-3" : "") +
            (activeId === h.id ? " active" : "")
          }
        >
          {h.text}
        </a>
      ))}
    </nav>
  );
}
