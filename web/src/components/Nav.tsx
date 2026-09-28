import { useEffect, useState } from "preact/hooks";
import { type Page, href } from "../lib/router.ts";
import { save } from "../lib/storage.ts";

export const REPO_URL = "https://github.com/Lazeeez/Odin";

type Theme = "light" | "dark";

/** The theme index.html applied before first paint (a saved choice, else the OS setting). */
const current = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(current);
  const next: Theme = theme === "dark" ? "light" : "dark";
  const flip = () => {
    // Applied right away, not in an effect: effects wait for the next paint.
    document.documentElement.dataset.theme = next;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "dark" ? "#0b0c10" : "#ffffff");
    setTheme(next);
    save("theme", next);
  };
  return (
    <button class="icon-btn" type="button" onClick={flip} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5" /><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z" /></svg>
      )}
    </button>
  );
}

export const Logo = () => (
  <svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true">
    <rect width="32" height="32" rx="8" />
    <circle cx="14" cy="14" r="6.5" />
    <path d="M18.8 18.8 24 24" />
  </svg>
);

const LINKS: [Page, string][] = [["search", "Search"], ["how", "How it works"], ["benchmarks", "Benchmarks"], ["explore", "Explore"]];

export function Nav({ page }: { page: Page }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [page]);
  return (
    <header class={`nav${open ? " open" : ""}`}>
      <div class="nav-inner">
        <a class="brand" href={href("home")} aria-label="Odin home"><Logo />Odin</a>
        <nav id="site-menu" aria-label="Main">
          {LINKS.map(([p, label]) => (
            <a key={p} href={href(p)} class={p === page ? "on" : ""} aria-current={p === page ? "page" : undefined}>{label}</a>
          ))}
        </nav>
        <div class="nav-actions">
          <ThemeToggle />
          <a class="icon-btn" href={REPO_URL} target="_blank" rel="noopener" aria-label="Source code on GitHub" title="Source code on GitHub">
            <svg viewBox="0 0 24 24" aria-hidden="true" class="fill"><path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.08.63-1.33-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.5 9.5 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" /></svg>
          </a>
          <a class="btn primary small nav-cta" href={href("search")}>Try Odin</a>
          <button class="icon-btn menu-btn" type="button" aria-expanded={open} aria-controls="site-menu" aria-label="Menu" onClick={() => setOpen(!open)}>
            <svg viewBox="0 0 24 24" aria-hidden="true">{open ? <path d="M6 6l12 12M18 6 6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}</svg>
          </button>
        </div>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer class="footer">
      <div class="footer-inner">
        <div>
          <a class="brand" href={href("home")}><Logo />Odin</a>
          <p class="muted small">Find the code behind a bug report. Open source, and it runs in your browser.</p>
        </div>
        <nav aria-label="Footer">
          {LINKS.map(([p, label]) => <a key={p} href={href(p)}>{label}</a>)}
          <a href={REPO_URL} target="_blank" rel="noopener">GitHub</a>
        </nav>
      </div>
      <p class="footer-note muted small">
        Evaluated on <a href="https://www.swebench.com" target="_blank" rel="noopener">SWE-bench</a>. Built with Python, Tree-sitter,
        LightGBM, PyTorch, TypeScript and Preact.
      </p>
    </footer>
  );
}
