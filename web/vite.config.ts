import preact from "@preact/preset-vite";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Preload the two faces the first screen needs (Inter for text, Cinzel for headings), so they are
 * fetched with the HTML instead of after the CSS: no flash of the fallback font on the headline.
 */
const preloadFonts = (): Plugin => ({
  name: "preload-fonts",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler: (_html, ctx) =>
      Object.keys(ctx.bundle ?? {})
        .filter((f) => /\/(inter|cinzel)-latin-wght-normal-[\w-]+\.woff2$/.test(f))
        .map((f) => ({ tag: "link", attrs: { rel: "preload", as: "font", type: "font/woff2", crossorigin: "", href: `./${f}` }, injectTo: "head" as const })),
  },
});

/**
 * public/sw.js drops an older build of a file when it caches a newer one, matching them by the
 * name before the hash. Two different files with the same name and extension in one build would
 * evict each other, so the build refuses them.
 */
const uniqueAssetNames = (): Plugin => ({
  name: "unique-asset-names",
  apply: "build",
  generateBundle(_options, bundle) {
    const seen = new Map<string, string>();
    for (const file of Object.keys(bundle)) {
      const m = file.match(/^(.*)-[\w-]{8}(\.\w+)$/);
      if (!m) continue;
      const stem = m[1] + m[2];
      if (seen.has(stem)) this.error(`${file} and ${seen.get(stem)} share a name: rename one (see public/sw.js).`);
      seen.set(stem, file);
    }
  },
});

export default defineConfig({
  // Relative asset URLs: the same build works at lazeeez.github.io/Odin/ and on Vercel.
  base: "./",
  plugins: [preact(), preloadFonts(), uniqueAssetNames()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    outDir: "dist",
    assetsInlineLimit: 0, // keep .wasm files as separately cached assets
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
