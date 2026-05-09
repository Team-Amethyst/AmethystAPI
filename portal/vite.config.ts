import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repoPublic = path.resolve(__dirname, "../public");

export default defineConfig({
  plugins: [react()],
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
      "/fixtures": { target: "http://localhost:3002", changeOrigin: true },
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
