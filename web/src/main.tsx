import { render } from "preact";
import { App } from "./App.tsx";
import { upgradeLegacyUrl } from "./lib/router.ts";
import "./styles.css";

upgradeLegacyUrl();
render(<App />, document.getElementById("app")!);

// Production only: cross-origin isolation (multi-threaded ML, ~2.5x faster rerank) and offline
// caching, see public/sw.js. Isolation applies to pages loaded under the service worker, so on
// the very first visit the page reloads once when the worker takes over, but only if the
// visitor has not started interacting yet, so it never interrupts anyone.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  let interacted = false;
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart", "scroll"])
    addEventListener(type, () => { interacted = true; }, { once: true, passive: true, capture: true });
  const firstInstall = !navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (firstInstall && !self.crossOriginIsolated && !interacted) location.reload();
  });
  addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
  });
}
