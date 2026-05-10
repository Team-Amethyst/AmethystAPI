import { useEffect, useRef } from "react";
import referenceInner from "../content/reference-inner.html?raw";

function attachReferenceDelegates(root: HTMLElement) {
  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const tocAnchor = t.closest(".reference-toc a[href^='#']") as HTMLAnchorElement | null;
    if (tocAnchor) {
      const href = tocAnchor.getAttribute("href");
      if (href && href.startsWith("#") && href.length > 1 && !href.startsWith("#/")) {
        const id = href.slice(1);
        const el = document.getElementById(id);
        if (el) {
          e.preventDefault();
          const reduce =
            typeof window.matchMedia === "function" &&
            window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
          return;
        }
      }
    }
    const header = t.closest(".endpoint-header");
    if (header) {
      const ep = header.closest(".endpoint");
      ep?.classList.toggle("open");
      return;
    }
    const copyBtn = t.closest(".copy-btn");
    if (copyBtn) {
      const block = copyBtn.closest(".code-block");
      const pre = block?.querySelector("pre");
      if (pre) {
        void navigator.clipboard.writeText(pre.textContent || "").then(() => {
          copyBtn.textContent = "Copied!";
          copyBtn.classList.add("copied");
          window.setTimeout(() => {
            copyBtn.textContent = "Copy";
            copyBtn.classList.remove("copied");
          }, 2000);
        });
      }
    }
  };
  root.addEventListener("click", onClick);
  return () => root.removeEventListener("click", onClick);
}

export function ReferenceTab() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return attachReferenceDelegates(el);
  }, []);

  return (
    <div className="tab-content active" id="tab-reference">
      <div ref={ref} className="portal-shell" dangerouslySetInnerHTML={{ __html: referenceInner }} />
    </div>
  );
}
