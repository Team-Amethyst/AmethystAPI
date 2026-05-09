import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repoPublic = path.resolve(__dirname, "../public");

/** Dev-only: serve `/fixtures/**` from repo `public/` so checkpoints load without running the API (avoids proxy + same-folder publicDir/outDir warning). */
function serveRepoFixturesDev(publicRoot: string): Plugin {
  return {
    name: "serve-repo-fixtures-dev",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = req.url?.split("?")[0] ?? "";
        if (!raw.startsWith("/fixtures/")) return next();
        const rel = decodeURIComponent(raw.slice(1));
        const filePath = path.normalize(path.join(publicRoot, rel));
        if (!filePath.startsWith(publicRoot)) return next();
        fs.stat(filePath, (err, st) => {
          if (err || !st.isFile()) return next();
          fs.readFile(filePath, (readErr, buf) => {
            if (readErr) return next();
            const ct = filePath.endsWith(".json")
              ? "application/json; charset=utf-8"
              : "application/octet-stream";
            res.setHeader("Content-Type", ct);
            res.end(buf);
          });
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [serveRepoFixturesDev(repoPublic), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:3002", changeOrigin: true },
      "/valuation": { target: "http://localhost:3002", changeOrigin: true },
      "/v1": { target: "http://localhost:3002", changeOrigin: true },
      "/catalog": { target: "http://localhost:3002", changeOrigin: true },
      "/analysis": { target: "http://localhost:3002", changeOrigin: true },
      "/simulation": { target: "http://localhost:3002", changeOrigin: true },
      "/signals": { target: "http://localhost:3002", changeOrigin: true },
    },
  },
  build: {
    outDir: repoPublic,
    emptyPublicDir: false,
    rollupOptions: {
      input: path.resolve(__dirname, "index.html"),
    },
  },
});
