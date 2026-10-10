import { defineConfig } from "vite";
export default defineConfig({
  // Relative assets work both at a domain root and /repository/ on GitHub Pages.
  base: "./",
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  build: { target: "es2022" },
});
