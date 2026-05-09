import { useEffect, useRef } from "react";
import referenceInner from "../content/reference-inner.html?raw";

function attachReferenceDelegates(root: HTMLElement) {
  const onClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement | null;
    if (!t) return;
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
