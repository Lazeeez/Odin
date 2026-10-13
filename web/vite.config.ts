import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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

const CONNECT = [
  "'self'",
  "https://api.github.com",
  "https://raw.githubusercontent.com",
  "https://cdn.jsdelivr.net",
  "https://data.jsdelivr.com",
  "https://huggingface.co",
  "https://*.huggingface.co",
  "https://*.hf.co",
  "https://*.workers.dev",
  "https://cloudflareinsights.com",
];

const contentSecurityPolicy = (inlineScripts: string[]) =>
  [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://static.cloudflareinsights.com ${inlineScripts.map((h) => `'sha256-${h}'`).join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src ${CONNECT.join(" ")}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");

const securityHeaders = (): Plugin => ({
  name: "security-headers",
  apply: "build",
  closeBundle() {
    const html = readFileSync("dist/index.html", "utf8");
    const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) =>
      createHash("sha256").update(m[1]).digest("base64"),
    );
    const everywhere = [
      "/*",
      `  Content-Security-Policy: ${contentSecurityPolicy(inline)}`,
      "  Cross-Origin-Opener-Policy: same-origin",
      "  Cross-Origin-Embedder-Policy: credentialless",
      "  X-Content-Type-Options: nosniff",
      "  Referrer-Policy: strict-origin-when-cross-origin",
      "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
    ];
    const hashed = ["/assets/*", "  Cache-Control: public, max-age=31536000, immutable"];
    writeFileSync("dist/_headers", [...everywhere, "", ...hashed, ""].join("\n"));
  },
});

export default defineConfig({
  // Relative asset URLs: the same build works at lazeeez.github.io/Odin/ and on Vercel.
  base: "./",
  plugins: [preact(), preloadFonts(), uniqueAssetNames(), securityHeaders()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    outDir: "dist",
    assetsInlineLimit: 0, // keep .wasm files as separately cached assets
  },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
