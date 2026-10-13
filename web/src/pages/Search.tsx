import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Emblem, Seer } from "../components/Emblem.tsx";
import { Bookmarklet } from "../components/Bookmarklet.tsx";
import { PageHero } from "../components/PageHero.tsx";
import { RecentChange } from "../components/RecentChange.tsx";
import { RuneProgress } from "../components/RuneProgress.tsx";
import { Seg } from "../components/Seg.tsx";
import { githubUrl, parseRepo } from "../engine/github.ts";
import { type Results, useSearchWorker } from "../hooks/useSearchWorker.ts";
import { highlightPython, matchedTerms } from "../lib/highlight.ts";
import { href, replaceHash } from "../lib/router.ts";
import { useLazy } from "../lib/lazy.ts";
import { load, save } from "../lib/storage.ts";
import type { RepoInfo, WireFile, WireHit } from "../worker/protocol.ts";

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

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false; // clipboard blocked: nothing to do
  }
}

/**
 * Why a result ranks where it does: each evidence group's contribution to the ranker's score,
 * against a typical candidate (see explain() in engine/rank.ts). Gold pushes it up, red down.
 */
function WhyBars({ why, rank }: { why: [string, number][]; rank: number }) {
  const top = Math.max(...why.map(([, v]) => Math.abs(v)), 1e-9);
  return (
    <div class="whybox">
      <p class="whybox-title">Why #{rank}? <span>What each kind of evidence added to the ranker's score, compared with a typical candidate</span></p>
      <ul>
        {why.map(([label, v]) => (
          <li key={label} class={v < 0 ? "neg" : ""}>
            <span class="wl">{label}</span>
            <span class="wtrack"><i style={{ width: `${(100 * Math.abs(v)) / top}%` }} /></span>
            <span class="wv">{v >= 0 ? "+" : "−"}{Math.abs(v).toFixed(2)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HitRow({ hit, rank, info, terms, open, onToggle }: {
  hit: WireHit; rank: number; info: RepoInfo; terms: readonly string[]; open: boolean; onToggle: () => void;
}) {
  const termSet = useMemo(() => new Set(terms), [terms]);
  const matched = useMemo(() => matchedTerms(`${hit.qualname}\n${hit.text}\n${hit.path}`, terms), [hit, terms]);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (await copyText(`${hit.path}:${hit.line}`)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <li class={open ? "open" : ""} data-copy={`${hit.path}:${hit.line}`}>
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
        <span class="hit-actions">
          <button class="link-btn" type="button" onClick={copy} title="Copy path:line (c)">{copied ? "Copied ✓" : "Copy path"}</button>
          <a class="gh-link" href={githubUrl(info.repo, info.branch, hit)} target="_blank" rel="noopener" title="Open on GitHub (o)">Open on GitHub ↗</a>
        </span>
      </div>
      {open && <RecentChange repo={info.repo} reference={info.branch} path={hit.path} />}
      {open && hit.why && hit.why.length > 0 && <WhyBars why={hit.why} rank={rank} />}
      {open && <CodeBlock hit={hit} terms={termSet} />}
    </li>
  );
}

/** Files from the file ranker when the semantic stage ran; else grouped from the function list. */
function FileRows({ hits, ranked, info }: { hits: WireHit[]; ranked?: WireFile[]; info: RepoInfo }) {
  const files = useMemo(() => {
    if (ranked) return ranked.map((f) => ({ path: f.path, score: f.score, funcs: f.functions }));
    const byPath = new Map<string, { path: string; score: number; funcs: WireHit[] }>();
    for (const h of hits) {
      const f = byPath.get(h.path) ?? { path: h.path, score: -Infinity, funcs: [] };
      f.score = Math.max(f.score, h.score);
      f.funcs.push(h);
      byPath.set(h.path, f);
    }
    return [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, 10);
  }, [hits, ranked]);
  return (
    <>
      {files.map((f, i) => (
        <li class="file-hit" key={f.path}>
          <div class="hit-head static">
            <span class="rank">{i + 1}</span>
            <span class="hit-main">
              <span class="qual">{f.path}</span>
              <span class="path">{f.funcs.length ? `${f.funcs.length} candidate function${f.funcs.length > 1 ? "s" : ""}` : "named in the issue or close in meaning"}</span>
            </span>
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

/**
 * Results are keyboard-navigable: j/k or arrows move, Enter expands, o opens on GitHub, c
 * copies the path. Ten show at first; the ranker returns up to fifty.
 */
function ResultList({ results, info, view }: { results: Results; info: RepoInfo; view: "functions" | "files" }) {
  const [openIds, setOpen] = useState<Set<string>>(new Set());
  const [shown, setShown] = useState(10);
  const list = useRef<HTMLOListElement>(null);
  useEffect(() => {
    setOpen(new Set(results.hits.slice(0, 1).map((h) => h.id)));
    setShown(10);
  }, [results]);
  const onKey = (e: KeyboardEvent) => {
    const heads = [...(list.current?.querySelectorAll<HTMLElement>(".hit-head") ?? [])];
    const at = heads.indexOf(document.activeElement as HTMLElement);
    if (at < 0 || e.ctrlKey || e.metaKey || e.altKey) return;
    const row = heads[at].closest("li");
    const go = (i: number) => heads[Math.max(0, Math.min(heads.length - 1, i))]?.focus();
    if (e.key === "j" || e.key === "ArrowDown") go(at + 1);
    else if (e.key === "k" || e.key === "ArrowUp") go(at - 1);
    else if (e.key === "o") row?.querySelector<HTMLAnchorElement>("a.gh-link")?.click();
    else if (e.key === "c") void copyText(row?.dataset.copy ?? "");
    else return;
    e.preventDefault();
  };
  if (!results.hits.length) {
    return <div class="empty-results">No function matches these words. Try names from the code, an error message or a parameter.</div>;
  }
  if (view === "files") return <ol class="hits"><FileRows hits={results.hits} ranked={results.files} info={info} /></ol>;
  const toggle = (id: string) => setOpen((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <>
      <ol class="hits" aria-live="polite" ref={list} onKeyDown={onKey}>
        {results.hits.slice(0, shown).map((h, i) => (
          <HitRow key={h.id} hit={h} rank={i + 1} info={info} terms={results.terms} open={openIds.has(h.id)} onToggle={() => toggle(h.id)} />
        ))}
      </ol>
      {results.hits.length > shown && (
        <button class="btn more" type="button" onClick={() => setShown(shown + 10)}>Show more results</button>
      )}
    </>
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
  const [showMap, setShowMap] = useState(false);
  const mapModule = useLazy(() => import("../components/RepoMap.tsx"), showMap);
  const RepoMap = mapModule?.default;
  useEffect(() => {
    if (showMap && info && !w.map && !info.partial) w.requestMap();
  }, [showMap, info, w.map]);
  const toResult = (path: string) =>
    document.querySelector(`.hits li[data-copy^="${CSS.escape(path)}:"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });

  const start = (input: string, tests = includeTests) => {
    setIssues(null);
    w.load(input, tests);
  };

  // A link, the home page or the GitHub bookmarklet asked for a repository, maybe with a query or
  // an issue number: load it once. An issue is fetched from GitHub's API while the code loads.
  useEffect(() => {
    const repo = request.get("repo");
    const issue = request.get("issue");
    const key = `${repo}#${issue ?? ""}`;
    if (!active || !repo || key === lastRequest.current) return;
    lastRequest.current = key;
    setRepoInput(repo);
    if (request.get("q") != null) setQuery(request.get("q")!);
    start(repo);
    if (issue && /^\d+$/.test(issue)) {
      fetch(`https://api.github.com/repos/${repo.replace(/^https?:\/\/github\.com\//, "").split("/").slice(0, 2).join("/")}/issues/${issue}`)
        .then((r) => (r.ok ? (r.json() as Promise<GitIssue>) : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((i) => setQuery(`${i.title}\n\n${(i.body ?? "").slice(0, 1500)}`))
        .catch(() => setQuery((q) => q || `#${issue}`));
    }
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
  }, [query, semanticOn, info, w.semanticIndex?.state]); // re-ranks when the semantic index is ready

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
      // Bug reports first; many projects label them "bug". Otherwise any open issue.
      const get = async (labels: string) => {
        const r = await fetch(`https://api.github.com/repos/${info.repo}/issues?state=open&per_page=30&sort=comments${labels}`);
        if (!r.ok) throw new Error(r.status === 403 || r.status === 429 ? "GitHub's hourly limit for your network is used up; try again later." : `GitHub answered HTTP ${r.status}.`);
        return ((await r.json()) as GitIssue[]).filter((i) => !i.pull_request);
      };
      let real = await get("&labels=bug");
      if (real.length < 3) real = [...real, ...(await get("")).filter((i) => !real.some((b) => b.number === i.number))];
      real = real.slice(0, 6);
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
      <PageHero kicker="Search" title="Search a repository">
        <p>Downloads a public Python repository into this tab, parses it with Tree-sitter (WebAssembly) and ranks every function against your bug report with learned rankers. No server of ours is involved.</p>
      </PageHero>

      <form class="card frame repo-card" onSubmit={submit}>
        <label class="field-label" for="repo-input">Repository</label>
        <div class="input-row">
          <input id="repo-input" type="text" value={repoInput} onInput={(e) => setRepoInput(e.currentTarget.value)}
            placeholder="owner/name or a GitHub link" autoComplete="off" spellcheck={false} />
          <button class="btn primary" type="submit" disabled={w.loading || !repoInput.trim()}>{w.loading ? <><Seer size="sm" />Loading…</> : "Load"}</button>
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
              {w.loading && info && <RuneProgress size="sm" fraction={w.status.fraction} label={w.status.text} />}
              <div class={`progress-text${w.status.error ? " error" : ""}`} role="status" aria-live="polite">{w.status.text}</div>
              {w.loading && <button class="link-btn push" type="button" onClick={w.cancel}>Cancel</button>}
            </div>
          </div>
        )}
      </form>

      {!info && !w.loading && (
        <div class="empty-state">
          <Emblem class="empty-emblem" />
          <h2>Start with a repository</h2>
          <p>Type <code>owner/name</code>, paste a GitHub link, or pick one above. Big projects like Django take a few seconds the first time; after that they load from your browser's cache.</p>
          <Bookmarklet />
        </div>
      )}
      {w.loading && !info && (
        <div class="loading-panel">
          <RuneProgress fraction={w.status?.fraction} label={w.status?.text} />
          <p class="loading-caption" aria-hidden="true">
            <b>The ravens are bringing back the code</b>
            {w.status?.text}
          </p>
        </div>
      )}

      {info && (
        <>
          <div class="repo-summary">
            <span class="repo-pill"><b>{info.repo}</b>{info.scope ? <> / {info.scope}</> : null} · {info.branch === "HEAD" ? "default branch" : info.branch}</span>
            {!info.partial && <span>{info.units.toLocaleString()} functions and classes in {info.files.toLocaleString()} files</span>}
            {info.partial ? (
              <span class="note live">Still loading: searching the {info.partial.filesDone.toLocaleString()}{info.partial.filesTotal ? ` of ${info.partial.filesTotal.toLocaleString()}` : ""} files parsed so far. Results refresh when it finishes.</span>
            ) : (
              <span class="muted">{info.fromCache ? "from your browser's cache" : `ready in ${(info.timings.loadMs / 1000).toFixed(1)} s`}</span>
            )}
            {!info.partial && w.semanticIndex && (
              <span class="muted" title="Every function embedded with a static code model, for search by meaning">
                {w.semanticIndex.state === "building" ? <Seer size="sm" text="building the semantic index…" /> : w.semanticIndex.state === "ready" ? `· semantic index ready in ${(w.semanticIndex.ms / 1000).toFixed(1)} s` : "· semantic index unavailable"}
              </span>
            )}
            {info.notes.map((n) => <span class="note" key={n}>{n}</span>)}
          </div>

          <div class="card frame query-card">
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
              <label class="switch" hidden={!w.stages?.rerank} title="Re-read the top candidates with a small language model (downloaded once, then cached)">
                <input type="checkbox" checked={semanticOn} onChange={(e) => setSemanticOn(e.currentTarget.checked)} />
                <span class="track" aria-hidden="true" />Language-model rerank
              </label>
              <button class={`link-btn push${showMap ? " on" : ""}`} type="button" aria-pressed={showMap} onClick={() => setShowMap(!showMap)}
                title="The repository as a tree, with the results lit up">{showMap ? "Hide the map" : "Show the map"}</button>
              <button class="link-btn" type="button" onClick={share}>{copied ? "Link copied ✓" : "Copy link"}</button>
            </div>
          </div>

          <div class="result-meta">
            <p class="tokens" role="status" aria-live="polite">{semanticStatus.includes("…") && <Seer size="sm" />} {semanticStatus}</p>
            {w.results && (
              <p class="tokens">
                {w.results.stage !== "rerank" && `${w.results.stage === "semantic" ? "Semantic" : "Instant"} ranking of ${info.units.toLocaleString()} functions in ${w.results.ms.toFixed(0)} ms · `}
                terms: {w.results.terms.slice(0, 24).map((t) => <span key={t}>{t}</span>)}
              </p>
            )}
          </div>
          {showMap && (
            RepoMap && w.map ? <RepoMap files={w.map} hits={w.results?.hits.slice(0, 10).map((h) => h.path) ?? []} onPick={toResult} />
              : <p class="muted small">{info.partial ? "The map is drawn once the repository finishes loading." : "Drawing the map…"}</p>
          )}
          {w.results ? <ResultList results={w.results} info={info} view={view} /> : query.trim() ? <Skeleton /> : null}
          <p class="fineprint">How accurate is this? <a href={href("benchmarks")}>See the benchmarks</a>.</p>
        </>
      )}
    </div>
  );
}
