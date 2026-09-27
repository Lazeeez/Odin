import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { githubUrl, parseRepo } from "../engine/github.ts";
import { SEMANTIC } from "../engine/semantic.ts";
import { useInView } from "../hooks/useInView.ts";
import { type Results, useSearchWorker } from "../hooks/useSearchWorker.ts";
import type { Lite } from "../lib/data.ts";
import { pct } from "../lib/format.ts";
import { highlightPython, matchedTerms } from "../lib/highlight.ts";
import { load, save } from "../lib/storage.ts";
import type { RepoInfo, WireHit } from "../worker/protocol.ts";
import { Seg } from "./Seg.tsx";

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
const DEFAULT_REPO = "psf/requests";

interface GitIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  pull_request?: unknown;
}

function LiteNote({ lite, fullHit10 }: { lite: Lite | null; fullHit10: number | null }) {
  if (!lite || fullHit10 == null) return null;
  const { keyword, stage1, stage2 } = lite.lite;
  return (
    <p class="accuracy-note">
      <b>How accurate is this in-browser version?</b> On {keyword.n} held-out benchmark bugs, a function the real fix changed
      is in the top 10 for <b>{pct((stage2 ?? stage1)["hit@10"])}</b> of bugs: keyword search alone gets {pct(keyword["hit@10"])},
      the learned ranker {pct(stage1["hit@10"])} instantly{stage2 && <>, and {pct(stage2["hit@10"])} once the semantic model has read its top {lite.depth}</>}.
      The full GPU pipeline reaches <b>{pct(fullHit10)}</b>: the gap is the larger code embedding model, git history, past fixes
      and the fine-tuned LLM reranker.
    </p>
  );
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

function HitRow({ hit, rank, info, terms, semantic, open, onToggle }: {
  hit: WireHit; rank: number; info: RepoInfo; terms: readonly string[]; semantic: boolean; open: boolean; onToggle: () => void;
}) {
  const termSet = useMemo(() => new Set(terms), [terms]);
  const matched = useMemo(() => matchedTerms(`${hit.qualname}\n${hit.text}\n${hit.path}`, terms), [hit, terms]);
  return (
    <li>
      <div class="hit-head" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}>
        <span class="rank">{rank}</span>
        <span class="qual">{hit.qualname}</span>
        <span class="path">{hit.path}</span>
        <span class="score" title="Learned ranker score (higher is more likely the fix)">{hit.score.toFixed(2)}</span>
      </div>
      {open && <CodeBlock hit={hit} terms={termSet} />}
      <div class="why">
        {hit.reasons.map((r) => <span class="reason" key={r}>{r}</span>)}
        {matched.length ? <>matches {matched.slice(0, 6).map(([t, c]) => <span class="term" key={t}>{t}{c > 1 ? ` ×${c}` : ""}</span>)}</> : <>no exact term overlap</>}
        {" · "}keyword {hit.bm25.toFixed(2)}
        {semantic && hit.semantic != null && <> · semantic {hit.semantic.toFixed(3)}</>}
        {" · "}<a href={githubUrl(info.repo, info.branch, hit)} target="_blank" rel="noopener">{hit.path}:{hit.line} ↗</a>
      </div>
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
          <div class="hit-head">
            <span class="rank">{i + 1}</span>
            <span class="qual">{f.path}</span>
            <span class="score">{f.funcs.length} match{f.funcs.length > 1 ? "es" : ""}</span>
          </div>
          <div class="funcs">
            {f.funcs.slice(0, 4).map((h) => (
              <div key={h.id}>↳ <a href={githubUrl(info.repo, info.branch, h)} target="_blank" rel="noopener">{h.qualname}</a></div>
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
    return <ol class="hits"><li class="empty">No function mentions these terms. Try words from the code: names, error messages, parameters.</li></ol>;
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
        <HitRow key={h.id} hit={h} rank={i + 1} info={info} terms={results.terms} semantic={results.stage === "semantic"}
          open={openIds.has(h.id)} onToggle={() => toggle(h.id)} />
      ))}
    </ol>
  );
}

const Skeleton = () => (
  <ol class="hits" aria-hidden="true">
    {[0, 1, 2].map((i) => <li key={i} class="skeleton"><span /><span /></li>)}
  </ol>
);

export function LiveSearch({ lite, fullHit10 }: { lite: Lite | null; fullHit10: number | null }) {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const w = useSearchWorker();
  const section = useRef<HTMLElement>(null);
  const queryBox = useRef<HTMLInputElement>(null);
  const started = useRef(false);
  const [repoInput, setRepoInput] = useState(params.get("repo") ?? DEFAULT_REPO);
  const [includeTests, setIncludeTests] = useState(false);
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [semanticOn, setSemanticOn] = useState(true);
  const [view, setView] = useState<"functions" | "files">("functions");
  const [recent, setRecent] = useState<string[]>(() => load("recentRepos", []));
  const [issues, setIssues] = useState<GitIssue[] | "loading" | string | null>(null);
  const [copied, setCopied] = useState(false);
  const inView = useInView(section, "300px", !params.get("repo"));

  const start = (input: string) => {
    started.current = true;
    setIssues(null);
    w.load(input, includeTests);
  };

  // Load from a shared link immediately, otherwise the default repo once the section is near.
  useEffect(() => {
    if (params.get("repo")) start(params.get("repo")!);
  }, []);
  useEffect(() => {
    if (inView && !started.current) start(repoInput);
  }, [inView]);

  // A repository finished loading: remember it, pick an example query, reflect it in the URL.
  useEffect(() => {
    const info = w.info;
    if (!info) return;
    const list = [info.repo, ...recent.filter((r) => r !== info.repo)].slice(0, 5);
    setRecent(list);
    save("recentRepos", list);
    if (!query && PRESETS[info.repo]) setQuery(PRESETS[info.repo][0]);
  }, [w.info]);

  // The one place searches start from: typing, chips, the semantic toggle and new repositories.
  useEffect(() => {
    if (!w.info) return;
    const t = setTimeout(() => {
      w.search(query, semanticOn);
      const url = new URL(location.href);
      url.searchParams.set("repo", w.info!.repo);
      if (query.trim()) url.searchParams.set("q", query.trim().slice(0, 500));
      else url.searchParams.delete("q");
      history.replaceState(null, "", url);
    }, 250);
    return () => clearTimeout(t);
  }, [query, semanticOn, w.info]);

  // "/" jumps to the search box, as on GitHub.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement as HTMLElement | null)?.tagName ?? "")) return;
      e.preventDefault();
      const target = queryBox.current ?? document.getElementById("repo-input");
      target?.scrollIntoView({ block: "center" });
      target?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const submit = (e: Event) => {
    e.preventDefault();
    try {
      const r = parseRepo(repoInput);
      const same = w.info && `${r.owner}/${r.name}`.toLowerCase() === w.info.repo.toLowerCase() && !r.ref;
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
    if (!w.info) return;
    setIssues("loading");
    try {
      const r = await fetch(`https://api.github.com/repos/${w.info.repo}/issues?state=open&per_page=30&sort=comments`);
      if (!r.ok) throw new Error(r.status === 403 ? "GitHub's API rate limit was reached; try again later." : `HTTP ${r.status}`);
      const all = (await r.json()) as GitIssue[];
      const real = all.filter((i) => !i.pull_request).slice(0, 6);
      setIssues(real.length ? real : "This repository has no open issues.");
    } catch (err) {
      setIssues(err instanceof Error ? err.message : String(err));
    }
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked: the address bar still has the link */
    }
  };

  const recentChips = recent.filter((r) => !(r in PRESETS) && r !== "django/django");
  const info = w.info;
  return (
    <section id="try" class="band" ref={section}>
      <h2>Try it on any Python repository</h2>
      <p class="sub">
        Paste a public GitHub repository. Your browser downloads its Python files, splits them into functions with Tree-sitter
        (compiled to WebAssembly), builds the project's code-aware BM25 index and ranks candidates with a learned model that reads what the issue
        names (tracebacks, quoted identifiers, module paths), then refines the best {SEMANTIC.depth} with a small embedding model,
        all in a background thread, with nothing sent to a server. Repositories and embeddings are cached, so
        coming back is instant.
      </p>
      <LiteNote lite={lite} fullHit10={fullHit10} />
      <form class="search-box" onSubmit={submit}>
        <input id="repo-input" type="text" value={repoInput} onInput={(e) => setRepoInput(e.currentTarget.value)}
          placeholder="owner/name or https://github.com/owner/name" aria-label="GitHub repository" autoComplete="off" spellcheck={false} />
        <label class="check"><input type="checkbox" checked={includeTests} onChange={(e) => setIncludeTests(e.currentTarget.checked)} /> include tests</label>
        <button class="btn primary" type="submit" disabled={w.loading}>Load repository</button>
      </form>
      <div class="chips">
        {recentChips.map((name) => <button key={name} class="chip recent" type="button" title="Recently searched" onClick={() => pick(name)}>{name}</button>)}
        {Object.keys(PRESETS).map((name) => <button key={name} class="chip" type="button" onClick={() => pick(name)}>{name}</button>)}
        <button class="chip" type="button" title="About 2,700 files: takes a while the first time" onClick={() => pick("django/django")}>django/django (large)</button>
      </div>

      {w.status && (
        <div class="progress">
          <div class="progress-row">
            <div class={`progress-text${w.status.error ? " error" : ""}`} role="status" aria-live="polite">{w.status.text}</div>
            {w.loading && <button class="link-btn" type="button" onClick={w.cancel}>Cancel</button>}
          </div>
          <div class="progress-bar"><i style={{ width: `${Math.round(100 * (w.status.fraction ?? 0))}%` }} /></div>
        </div>
      )}
      {w.loading && !info && <Skeleton />}

      {info && !w.loading && (
        <div>
          <div class="repo-info">
            <b>{info.repo}</b> @ {info.branch} · {info.files.toLocaleString()} files · <b>{info.units.toLocaleString()}</b> functions and classes ·{" "}
            {info.fromCache ? "loaded from your browser's cache" : `downloaded and parsed in ${(info.timings.loadMs / 1000).toFixed(1)} s`}, indexed in{" "}
            {info.timings.indexMs.toFixed(0)} ms
            {info.notes.map((n) => <span class="warn" key={n}>{n}</span>)}
          </div>
          <div class="search-box">
            <input ref={queryBox} id="demo-query" type="search" value={query} onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder="Describe a bug or paste an error message… (press / to focus)" autoComplete="off" aria-label="Bug description" />
            <label class="check" title="Rerank the top candidates with a small embedding model (downloaded once, then cached)">
              <input type="checkbox" checked={semanticOn} onChange={(e) => setSemanticOn(e.currentTarget.checked)} /> semantic rerank
            </label>
          </div>
          <div class="chips">
            {(PRESETS[info.repo] ?? []).map((ex) => <button key={ex} class="chip" type="button" onClick={() => setQuery(ex)}>{ex}</button>)}
            {issues == null && <button class="chip accent" type="button" onClick={fetchIssues}>Try a real open issue from {info.repo}</button>}
            {issues === "loading" && <span class="muted">Fetching open issues…</span>}
            {typeof issues === "string" && issues !== "loading" && <span class="muted">{issues}</span>}
            {Array.isArray(issues) && issues.map((i) => (
              <button key={i.number} class="chip issue" type="button" title={i.html_url}
                onClick={() => setQuery(`${i.title}\n\n${(i.body ?? "").slice(0, 1500)}`)}>#{i.number} {i.title}</button>
            ))}
          </div>
          <div class="results-bar">
            <Seg small label="Result granularity" value={view} onChange={setView} options={[["functions", "Functions"], ["files", "Files"]] as const} />
            <button class="link-btn" type="button" onClick={share}>{copied ? "Link copied ✓" : "Copy link to this search"}</button>
          </div>
          <p class="tokens" role="status" aria-live="polite">{w.semantic}{w.backend && w.semantic.startsWith("semantic") ? ` · ${w.backend === "webgpu" ? "GPU (WebGPU)" : "CPU (WebAssembly)"}` : ""}</p>
          {w.results && (
            <p class="tokens">
              query terms: {w.results.terms.map((t) => <span key={t}>{t}</span>)}
              {w.results.stage === "keyword" && ` · ranked ${info.units.toLocaleString()} functions in ${w.results.ms.toFixed(1)} ms`}
            </p>
          )}
          {w.results ? <ResultList results={w.results} info={info} view={view} /> : query.trim() ? <Skeleton /> : null}
        </div>
      )}
    </section>
  );
}
