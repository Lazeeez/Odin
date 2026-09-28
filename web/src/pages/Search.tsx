import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Seg } from "../components/Seg.tsx";
import { githubUrl, parseRepo } from "../engine/github.ts";
import { type Results, useSearchWorker } from "../hooks/useSearchWorker.ts";
import { highlightPython, matchedTerms } from "../lib/highlight.ts";
import { href, replaceHash } from "../lib/router.ts";
import { load, save } from "../lib/storage.ts";
import type { RepoInfo, WireHit } from "../worker/protocol.ts";

const PRESETS: Record<string, string[]> = {
  "psf/requests": [
    "redirect drops the Authorization header when switching hosts",
    "proxy credentials are not used for HTTPS requests",
    "timeout is ignored when streaming the response body",
  ],
  "pallets/flask": [
    "url_for fails to build a URL for a blueprint endpoint",
    "session cookie is not set when SESSION_COOKIE_SECURE is enabled",
    "teardown callbacks are not called after an exception",
  ],
  "fastapi/fastapi": [
    "dependency with yield is not cleaned up after an exception",
    "OpenAPI schema is wrong for a response_model with a list of models",
  ],
  "psf/black": ["crash formatting a nested f-string", "magic trailing comma is ignored in a function signature"],
};
const EXAMPLES = ["pallets/flask", "psf/requests", "fastapi/fastapi", "psf/black", "django/django"];

interface GitIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  pull_request?: unknown;
}

function CodeBlock({ hit, terms }: { hit: WireHit; terms: ReadonlySet<string> }) {
  const html = useMemo(() => highlightPython(hit.text, terms), [hit.text, terms]);
  const n = hit.text.split("\n").length;
  // A class unit omits its methods' lines, so its lines are not contiguous: no line numbers.
  const gutter = hit.kind === "class" ? "" : Array.from({ length: n }, (_, i) => hit.line + i).join("\n");
  return (
    <div class="codewrap">
      <pre class="gutter" aria-hidden="true">{gutter}</pre>
      <pre class="src" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

function HitRow({ hit, rank, info, terms, open, onToggle }: {
  hit: WireHit; rank: number; info: RepoInfo; terms: readonly string[]; open: boolean; onToggle: () => void;
}) {
  const termSet = useMemo(() => new Set(terms), [terms]);
  const matched = useMemo(() => matchedTerms(`${hit.qualname}\n${hit.text}\n${hit.path}`, terms), [hit, terms]);
  return (
    <li class={open ? "open" : ""}>
      <div class="hit-head" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
        <span class="rank">{rank}</span>
        <span class="hit-main">
          <span class="qual">{hit.qualname}</span>
          <span class="path">{hit.path}:{hit.line}</span>
        </span>
        <svg class="chev" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      </div>
      <div class="why">
        {hit.reasons.map((r) => <span class="reason" key={r}>{r}</span>)}
        {matched.slice(0, 5).map(([t, c]) => <span class="term" key={t}>{t}{c > 1 ? ` ×${c}` : ""}</span>)}
        <a class="gh-link" href={githubUrl(info.repo, info.branch, hit)} target="_blank" rel="noopener">Open on GitHub ↗</a>
      </div>
      {open && <CodeBlock hit={hit} terms={termSet} />}
    </li>
  );
}

function FileRows({ hits, info }: { hits: WireHit[]; info: RepoInfo }) {
  const files = useMemo(() => {
    const byPath = new Map<string, { path: string; score: number; funcs: WireHit[] }>();
    for (const h of hits) {
      const f = byPath.get(h.path) ?? { path: h.path, score: -Infinity, funcs: [] };
      f.score = Math.max(f.score, h.score);
      f.funcs.push(h);
      byPath.set(h.path, f);
    }
    return [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, 10);
  }, [hits]);
  return (
    <>
      {files.map((f, i) => (
        <li class="file-hit" key={f.path}>
          <div class="hit-head static">
            <span class="rank">{i + 1}</span>
            <span class="hit-main"><span class="qual">{f.path}</span><span class="path">{f.funcs.length} matching function{f.funcs.length > 1 ? "s" : ""}</span></span>
          </div>
          <div class="funcs">
            {f.funcs.slice(0, 4).map((h) => (
              <a key={h.id} href={githubUrl(info.repo, info.branch, h)} target="_blank" rel="noopener">{h.qualname}</a>
            ))}
          </div>
        </li>
      ))}
    </>
  );
}

function ResultList({ results, info, view }: { results: Results; info: RepoInfo; view: "functions" | "files" }) {
  const [openIds, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => setOpen(new Set(results.hits.slice(0, 1).map((h) => h.id))), [results]);
  if (!results.hits.length) {
    return <div class="empty-results">No function matches these words. Try names from the code, an error message or a parameter.</div>;
  }
  if (view === "files") return <ol class="hits"><FileRows hits={results.hits} info={info} /></ol>;
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <ol class="hits" aria-live="polite">
      {results.hits.slice(0, 10).map((h, i) => (
        <HitRow key={h.id} hit={h} rank={i + 1} info={info} terms={results.terms} open={openIds.has(h.id)} onToggle={() => toggle(h.id)} />
      ))}
    </ol>
  );
}

const Skeleton = () => (
  <ol class="hits" aria-hidden="true">
    {[0, 1, 2].map((i) => <li key={i} class="skeleton"><span /><span /></li>)}
  </ol>
);

/**
 * The search app. It stays mounted while the visitor browses other pages (hidden, not
 * destroyed), so a loaded repository and its results survive a trip to the docs.
 */
export function Search({ active, request }: { active: boolean; request: URLSearchParams }) {
  const w = useSearchWorker();
  const queryBox = useRef<HTMLTextAreaElement>(null);
  const lastRequest = useRef<string | null>(null);
  const [repoInput, setRepoInput] = useState(request.get("repo") ?? "");
  const [includeTests, setIncludeTests] = useState(false);
  const [query, setQuery] = useState(request.get("q") ?? "");
  const [semanticOn, setSemanticOn] = useState(true);
  const [view, setView] = useState<"functions" | "files">("functions");
  const [recent, setRecent] = useState<string[]>(() => load("recentRepos", []));
  const [issues, setIssues] = useState<GitIssue[] | "loading" | string | null>(null);
  const [copied, setCopied] = useState(false);
  const info = w.info;

  const start = (input: string, tests = includeTests) => {
    setIssues(null);
    w.load(input, tests);
  };

  // A link or the home page asked for a repository (and maybe a query): load it once.
  useEffect(() => {
    const repo = request.get("repo");
    if (!active || !repo || repo === lastRequest.current) return;
    lastRequest.current = repo;
    setRepoInput(repo);
    if (request.get("q") != null) setQuery(request.get("q")!);
    start(repo);
  }, [active, request]);

  // A repository finished loading: remember it and offer an example query.
  useEffect(() => {
    if (!info) return;
    const list = [info.repo, ...recent.filter((r) => r.toLowerCase() !== info.repo.toLowerCase())].slice(0, 6);
    setRecent(list);
    save("recentRepos", list);
    if (!query && PRESETS[info.repo]) setQuery(PRESETS[info.repo][0]);
  }, [info]);

  // The one place searches start from: typing, chips, the semantic switch and new repositories.
  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => w.search(query, semanticOn), 250);
    return () => clearTimeout(t);
  }, [query, semanticOn, info]);

  // The address bar always holds a shareable link to what is on screen.
  const link = info ? href("search", null, { repo: info.repo, q: query.trim().slice(0, 500) || undefined }) : href("search");
  useEffect(() => {
    if (active && info) replaceHash(link);
  }, [active, link]);

  // "/" jumps to the search box, as on GitHub.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement as HTMLElement | null)?.tagName ?? "")) return;
      e.preventDefault();
      (queryBox.current ?? document.getElementById("repo-input"))?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active]);

  const submit = (e: Event) => {
    e.preventDefault();
    if (!repoInput.trim()) return;
    try {
      const r = parseRepo(repoInput);
      const same = info && `${r.owner}/${r.name}`.toLowerCase() === info.repo.toLowerCase() && !r.ref;
      if (same && !w.loading) return queryBox.current?.focus();
    } catch {
      /* invalid input: the loader explains */
    }
    setQuery("");
    start(repoInput);
  };

  const pick = (name: string) => {
    setRepoInput(name);
    setQuery("");
    start(name);
  };

  const fetchIssues = async () => {
    if (!info) return;
    setIssues("loading");
    try {
      const r = await fetch(`https://api.github.com/repos/${info.repo}/issues?state=open&per_page=30&sort=comments`);
      if (!r.ok) throw new Error(r.status === 403 || r.status === 429 ? "GitHub's hourly limit for your network is used up; try again later." : `GitHub answered HTTP ${r.status}.`);
      const all = (await r.json()) as GitIssue[];
      const real = all.filter((i) => !i.pull_request).slice(0, 6);
      setIssues(real.length ? real : "This repository has no open issues.");
    } catch (err) {
      setIssues(err instanceof TypeError ? "Couldn't reach GitHub." : err instanceof Error ? err.message : String(err));
    }
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(`${location.origin}${location.pathname}${link}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked: the address bar still has the link */
    }
  };

  const chips = [...recent, ...EXAMPLES.filter((e) => !recent.some((r) => r.toLowerCase() === e.toLowerCase()))].slice(0, 7);
  const semanticStatus = w.semantic ? `${w.semantic}${w.backend && w.semantic.startsWith("semantic") ? ` · ${w.backend === "webgpu" ? "GPU" : "CPU"}` : ""}` : "";

  return (
    <div class="container app" id="search-app">
      <header class="page-head">
        <h1>Search a repository</h1>
        <p>Load any public Python project from GitHub, then describe a bug. Everything runs in your browser.</p>
      </header>

      <form class="card repo-card" onSubmit={submit}>
        <label class="field-label" for="repo-input">Repository</label>
        <div class="input-row">
          <input id="repo-input" type="text" value={repoInput} onInput={(e) => setRepoInput(e.currentTarget.value)}
            placeholder="owner/name or a GitHub link" autoComplete="off" spellcheck={false} />
          <button class="btn primary" type="submit" disabled={w.loading || !repoInput.trim()}>{w.loading ? "Loading…" : "Load"}</button>
        </div>
        <div class="row-between">
          <div class="chips">
            {chips.map((name) => (
              <button key={name} class={`chip${recent.includes(name) ? " recent" : ""}`} type="button" onClick={() => pick(name)}
                title={recent.includes(name) ? "Recently searched" : undefined}>{name}</button>
            ))}
          </div>
          <label class="switch">
            <input type="checkbox" checked={includeTests} onChange={(e) => setIncludeTests(e.currentTarget.checked)} />
            <span class="track" aria-hidden="true" />Include tests
          </label>
        </div>
        {w.status && (
          <div class="progress">
            <div class="progress-row">
              <div class={`progress-text${w.status.error ? " error" : ""}`} role="status" aria-live="polite">{w.status.text}</div>
              {w.loading && <button class="link-btn" type="button" onClick={w.cancel}>Cancel</button>}
            </div>
            {!w.status.error && <div class="progress-bar"><i style={{ width: `${Math.round(100 * (w.status.fraction ?? 0))}%` }} /></div>}
          </div>
        )}
      </form>

      {!info && !w.loading && (
        <div class="empty-state">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m15.5 15.5 5 5" /></svg>
          <h2>Start with a repository</h2>
          <p>Type <code>owner/name</code>, paste a GitHub link, or pick one above. Big projects like Django take a few seconds the first time; after that they load from your browser's cache.</p>
        </div>
      )}
      {w.loading && !info && <Skeleton />}

      {info && (
        <>
          <div class="repo-summary">
            <span class="repo-pill"><b>{info.repo}</b>{info.scope ? <> / {info.scope}</> : null} · {info.branch === "HEAD" ? "default branch" : info.branch}</span>
            <span>{info.units.toLocaleString()} functions and classes in {info.files.toLocaleString()} files</span>
            <span class="muted">{info.fromCache ? "from your browser's cache" : `ready in ${(info.timings.loadMs / 1000).toFixed(1)} s`}</span>
            {info.notes.map((n) => <span class="note" key={n}>{n}</span>)}
          </div>

          <div class="card query-card">
            <label class="field-label" for="demo-query">Bug report</label>
            <textarea ref={queryBox} id="demo-query" value={query} onInput={(e) => setQuery(e.currentTarget.value)}
              rows={Math.min(10, Math.max(3, query.split("\n").length))}
              placeholder="Paste an issue or a traceback, or describe what goes wrong… (press / to focus)" aria-label="Bug report" />
            <div class="chips">
              {(PRESETS[info.repo] ?? []).map((ex) => <button key={ex} class="chip" type="button" onClick={() => setQuery(ex)}>{ex}</button>)}
              {issues == null && <button class="chip accent" type="button" onClick={fetchIssues}>Use an open issue from {info.repo}</button>}
              {issues === "loading" && <span class="muted small">Fetching open issues…</span>}
              {typeof issues === "string" && issues !== "loading" && <span class="muted small">{issues}</span>}
              {Array.isArray(issues) && issues.map((i) => (
                <button key={i.number} class="chip issue" type="button" title={i.html_url}
                  onClick={() => setQuery(`${i.title}\n\n${(i.body ?? "").slice(0, 1500)}`)}>#{i.number} {i.title}</button>
              ))}
            </div>
            <div class="toolbar">
              <Seg small label="Result granularity" value={view} onChange={setView} options={[["functions", "Functions"], ["files", "Files"]] as const} />
              <label class="switch" title="Re-read the top candidates with a small language model (downloaded once, then cached)">
                <input type="checkbox" checked={semanticOn} onChange={(e) => setSemanticOn(e.currentTarget.checked)} />
                <span class="track" aria-hidden="true" />Semantic rerank
              </label>
              <button class="link-btn push" type="button" onClick={share}>{copied ? "Link copied ✓" : "Copy link"}</button>
            </div>
          </div>

          <div class="result-meta">
            <p class="tokens" role="status" aria-live="polite">{semanticStatus}</p>
            {w.results && (
              <p class="tokens">
                {w.results.stage === "keyword" && `Ranked ${info.units.toLocaleString()} functions in ${w.results.ms.toFixed(0)} ms · `}
                terms: {w.results.terms.slice(0, 24).map((t) => <span key={t}>{t}</span>)}
              </p>
            )}
          </div>
          {w.results ? <ResultList results={w.results} info={info} view={view} /> : query.trim() ? <Skeleton /> : null}
          <p class="fineprint">How accurate is this? <a href={href("benchmarks")}>See the benchmarks</a>.</p>
        </>
      )}
    </div>
  );
}
