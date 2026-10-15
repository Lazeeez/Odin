import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../csp.ts";

const directives = new Map(
  contentSecurityPolicy([]).split(";").map((d) => {
    const [name, ...values] = d.trim().split(/\s+/);
    return [name, new Set(values)] as const;
  }),
);
const allows = (directive: string, source: string) => directives.get(directive)?.has(source) ?? false;

const worker = readFileSync(new URL("../src/worker/search.worker.ts", import.meta.url), "utf-8");
const cdn = new URL(worker.match(/TRANSFORMERS_CDN = "([^"]+)"/)![1]).origin;
const runtime = new URL(worker.match(/ORT_RUNTIME = "([^"]+)"/)![1]).origin;

describe("content security policy", () => {
  it("lets the rerank model load its runtime from the CDN and import it from a blob URL", () => {
    expect(allows("script-src", cdn)).toBe(true);
    expect(allows("script-src", runtime)).toBe(true);
    expect(allows("connect-src", runtime)).toBe(true);
    expect(allows("script-src", "blob:")).toBe(true);
    expect(allows("script-src", "'wasm-unsafe-eval'")).toBe(true);
    expect(allows("worker-src", "blob:")).toBe(true);
  });

  it("loads the same ONNX runtime build that the pinned transformers.js release uses", () => {
    const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf-8"));
    const version = lock.packages["node_modules/onnxruntime-web"].version;
    expect(worker).toContain(`ORT_RUNTIME = "https://unpkg.com/onnxruntime-web@${version}/dist/"`);
  });

  it("lets the model and its runtime be downloaded", () => {
    expect(allows("connect-src", cdn)).toBe(true);
    expect(allows("connect-src", "https://huggingface.co")).toBe(true);
    expect(allows("connect-src", "https://*.hf.co")).toBe(true);
  });

  it("keeps the API and the relay same-origin and nothing else open", () => {
    expect(allows("connect-src", "'self'")).toBe(true);
    expect(allows("script-src", "'unsafe-eval'")).toBe(false);
    expect(allows("script-src", "*")).toBe(false);
    expect(allows("object-src", "'none'")).toBe(true);
    expect(allows("frame-ancestors", "'none'")).toBe(true);
  });
});
