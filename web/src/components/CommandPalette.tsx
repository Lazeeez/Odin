import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { href, type Page } from "../lib/router.ts";
import { load } from "../lib/storage.ts";

interface Command { title: string; hint: string; run: () => void }

const go = (hash: string) => { location.hash = hash; };
const EXAMPLES = ["pallets/flask", "axios/axios", "sindresorhus/ky", "gin-gonic/gin", "google/gson", "BurntSushi/ripgrep", "django/django"];
const PAGES: [Page, string][] = [["home", "Home"], ["search", "Search a repository"], ["how", "How it works"], ["benchmarks", "Benchmarks"], ["explore", "Explore real bugs"]];

/** Loose subsequence match, scored so earlier and contiguous hits rank first. */
function score(text: string, q: string): number {
  const t = text.toLowerCase();
  let at = -1;
  let s = 0;
  for (const ch of q.toLowerCase()) {
    const i = t.indexOf(ch, at + 1);
    if (i < 0) return -1;
    s += i === at + 1 ? 2 : 1;
    at = i;
  }
  return s - at / 100;
}

/**
 * Ctrl+K from anywhere: jump to a page, load a repository (anything shaped like owner/name, a
 * GitHub link, a recent or an example one), switch the theme. Arrow keys and Enter, Escape closes.
 */
export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const commands = useMemo<Command[]>(() => {
    const recent: string[] = load("recentRepos", []);
    const repos = [...new Set([...recent, ...EXAMPLES])];
    const typed = q.trim().replace(/^https?:\/\/github\.com\//, "");
    const list: Command[] = [];
    if (/^[\w.-]+\/[\w.-]+/.test(typed)) list.push({ title: `Load ${typed}`, hint: "repository", run: () => go(href("search", null, { repo: typed })) });
    list.push(
      ...PAGES.map(([p, title]) => ({ title, hint: "page", run: () => go(href(p)) })),
      ...repos.map((r) => ({ title: `Load ${r}`, hint: recent.includes(r) ? "recent" : "example", run: () => go(href("search", null, { repo: r })) })),
      { title: "Switch light / dark", hint: "theme", run: () => document.querySelector<HTMLButtonElement>("button[aria-label^='Switch to']")?.click() },
      { title: "Play Beat Odin", hint: "game", run: () => go(href("explore", null, { mode: "game" })) },
    );
    const unique = list.filter((c, i) => list.findIndex((d) => d.title.toLowerCase() === c.title.toLowerCase()) === i);
    if (!typed) return unique;
    return unique.map((c) => [c, score(c.title, typed)] as const).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).map(([c]) => c);
  }, [q]);

  useEffect(() => setAt(0), [q]);
  const run = (c?: Command) => {
    if (!c) return;
    onClose();
    c.run();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") setAt((i) => Math.min(commands.length - 1, i + 1));
    else if (e.key === "ArrowUp") setAt((i) => Math.max(0, i - 1));
    else if (e.key === "Enter") run(commands[at]);
    else return;
    e.preventDefault();
  };

  return (
    <div class="palette-backdrop" onClick={onClose}>
      <div class="palette frame" role="dialog" aria-modal="true" aria-label="Command palette" onClick={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <input ref={input} type="text" value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder="Type a command, a page or owner/repository…"
          aria-label="Command" aria-controls="palette-list" aria-activedescendant={commands[at] ? `cmd-${at}` : undefined} />
        <ul id="palette-list" role="listbox" aria-label="Commands">
          {commands.slice(0, 9).map((c, i) => (
            <li key={c.title} id={`cmd-${i}`} role="option" aria-selected={i === at} class={i === at ? "on" : ""}
              onPointerEnter={() => setAt(i)} onClick={() => run(c)}>
              <span>{c.title}</span><span class="hint">{c.hint}</span>
            </li>
          ))}
          {!commands.length && <li class="empty">Nothing matches. Try a page name, or owner/repository.</li>}
        </ul>
        <p class="palette-foot"><kbd>↑</kbd><kbd>↓</kbd> choose · <kbd>Enter</kbd> run · <kbd>Esc</kbd> close</p>
      </div>
    </div>
  );
}
