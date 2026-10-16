import { useEffect, useState } from "preact/hooks";
import { REPO_URL } from "../lib/links.ts";
import { type Page, href } from "../lib/router.ts";
import { save } from "../lib/storage.ts";
import { Emblem } from "./Emblem.tsx";

type Theme = "light" | "dark";

/** The theme index.html applied before first paint (a saved choice, else light). */
const current = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(current);
  const next: Theme = theme === "dark" ? "light" : "dark";
  const flip = () => {
    // Applied right away, not in an effect: effects wait for the next paint.
    document.documentElement.dataset.theme = next;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", next === "dark" ? "#0f1424" : "#faf6ee");
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

export const Logo = () => <Emblem />;

const LINKS: [Page, string][] = [["search", "Search"], ["how", "How it works"], ["benchmarks", "Benchmarks"], ["explore", "Explore"], ["case", "Case study"]];

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
          <button class="icon-btn palette-btn" type="button" onClick={() => dispatchEvent(new Event("odin:palette"))} aria-label="Open the command palette (Ctrl+K)" title="Command palette (Ctrl+K)">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></svg>
          </button>
          <ThemeToggle />
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
        <a class="brand" href={href("home")}><Logo />Odin</a>
        <nav aria-label="Footer">
          {LINKS.map(([p, label]) => <a key={p} href={href(p)}>{label}</a>)}
        </nav>
      </div>
      <p class="footer-note muted small">
        Evaluated on <a href="https://www.swebench.com" target="_blank" rel="noopener">SWE-bench</a>. <a href={REPO_URL} target="_blank" rel="noopener">Source on GitHub</a>.
      </p>
    </footer>
  );
}
