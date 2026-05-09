import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { SandboxKeyProvider } from "@/context/SandboxKeyContext";
import { router } from "@/router";
import "@/styles/index.css";

(function normalizeLegacyHash() {
  let h = window.location.hash.replace(/^#/, "");
  if (!h || h.startsWith("/")) return;
  if (h === "organization") h = "keys";
  if (/^[\w-]+$/.test(h)) {
    window.location.hash = `#/${h}`;
  }
})();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SandboxKeyProvider>
        <RouterProvider router={router} />
      </SandboxKeyProvider>
    </QueryClientProvider>
  </StrictMode>
);
