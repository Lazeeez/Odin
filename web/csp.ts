export const CONNECT = [
  "'self'",
  "https://api.github.com",
  "https://raw.githubusercontent.com",
  "https://cdn.jsdelivr.net",
  "https://data.jsdelivr.com",
  "https://huggingface.co",
  "https://*.huggingface.co",
  "https://*.hf.co",
  "https://cloudflareinsights.com",
];

export const contentSecurityPolicy = (inlineScripts: string[]) =>
  [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net https://static.cloudflareinsights.com ${inlineScripts.map((h) => `'sha256-${h}'`).join(" ")}`,
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
