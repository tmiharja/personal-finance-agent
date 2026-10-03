"use client";

// Ported from tmiharja/portfolio-website so both sites share the same header behaviour.

import { useEffect, useRef, type ReactNode } from "react";

// Scroll distance (px) after which the header gains its solid backdrop.
const THRESHOLD = 8;

/**
 * Fixed header wrapper. Marks itself `data-scrolled` once the page moves so the
 * CSS can fade in a backdrop; it writes the attribute directly rather than
 * through state, so scrolling never re-renders the header.
 */
export default function HeaderShell({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let frame = 0;
    const update = () => {
      frame = 0;
      el.dataset.scrolled = String(window.scrollY > THRESHOLD);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <header ref={ref} data-scrolled="false" className="site-header">
      {children}
    </header>
  );
}
