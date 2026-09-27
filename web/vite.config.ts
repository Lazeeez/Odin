import preact from "@preact/preset-vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Relative asset URLs: the same build works at lazeeez.github.io/Odin/ and on Vercel.
  base: "./",
  plugins: [preact()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    outDir: "dist",
    assetsInlineLimit: 0, // keep .wasm files as separately cached assets
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
