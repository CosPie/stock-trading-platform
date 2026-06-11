import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  root: "frontend",
  build: {
    outDir: "../web",
    emptyOutDir: false,
    rollupOptions: {
      input: {
        index: resolve(__dirname, "frontend/index.html"),
        report: resolve(__dirname, "frontend/report.html"),
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:16666",
    },
  },
});
