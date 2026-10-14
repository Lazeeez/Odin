/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the archive relay (proxy/cloudflare-worker.js), if deployed: one download per repository. */
  readonly VITE_ARCHIVE_PROXY?: string;
  readonly VITE_API?: string;
}
