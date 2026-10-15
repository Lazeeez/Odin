import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Emblem, Seer } from "../components/Emblem.tsx";
import { Bookmarklet } from "../components/Bookmarklet.tsx";
import { PageHero } from "../components/PageHero.tsx";
import { RecentChange } from "../components/RecentChange.tsx";
import { RuneProgress } from "../components/RuneProgress.tsx";
import { Seg } from "../components/Seg.tsx";
import { githubApi, githubUrl, issueNumber, parseRepo } from "../engine/github.ts";
import { feedbackEnabled, newSession, type QuerySource, recordSearch, recordVote } from "../lib/feedback.ts";
import { type Results, useSearchWorker } from "../hooks/useSearchWorker.ts";
import { highlightCode, matchedTerms } from "../lib/highlight.ts";
import { href, replaceHash } from "../lib/router.ts";
import { useLazy } from "../lib/lazy.ts";
import { load, save } from "../lib/storage.ts";
import { duration } from "../lib/format.ts";
import type { RankStage, RepoInfo, WireFile, WireHit } from "../worker/protocol.ts";

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
  const html = useMemo(() => highlightCode(hit.text, terms, hit.path), [hit.text, terms, hit.path]);
  const n = hit.text.split("\n").length;
  // A class unit omits its methods' lines, so its lines are not contiguous: no line numbers.
  const gutter = hit.kind === "class" ? "" : Array.from({ length: n }, (_, i) => hit.line + i).join("\n");
  return (
    <div class="codewrap" tabIndex={0} role="region" aria-label={`Source of ${hit.qualname}`}>
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

interface Rating {
  session: string;
  stage: RankStage;
  issue: string | null;
}

function Vote({ hit, rank, info, rating }: { hit: WireHit; rank: number; info: RepoInfo; rating: Rating }) {
  const [state, setState] = useState<{ session: string; vote: 1 | -1; failed: boolean } | null>(null);
  const current = state?.session === rating.session ? state : null;
  const cast = async (vote: 1 | -1) => {
    setState({ session: rating.session, vote, failed: false });
    const ok = await recordVote({
      repo: info.repo, sha: info.sha, unit: hit.id, rank, vote, stage: rating.stage, issue: rating.issue, session: rating.session,
    });
    if (!ok) setState({ session: rating.session, vote, failed: true });
  };
  return (
    <span class="vote" title="Is this where the fix goes? Odin records the repository, this function and its rank, never your bug report.">
      <span class="vote-q">{current ? (current.failed ? "Not saved" : "Thanks") : "Right place?"}</span>
      <button type="button" class={`vote-btn${current?.vote === 1 ? " on" : ""}`} aria-pressed={current?.vote === 1} aria-label="Yes, the fix goes here" onClick={() => cast(1)}>👍</button>
      <button type="button" class={`vote-btn${current?.vote === -1 ? " on" : ""}`} aria-pressed={current?.vote === -1} aria-label="No, not here" onClick={() => cast(-1)}>👎</button>
    </span>
  );
}

function HitRow({ hit, rank, info, terms, open, onToggle, rating }: {
  hit: WireHit; rank: number; info: RepoInfo; terms: readonly string[]; open: boolean; onToggle: () => void; rating: Rating | null;
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
          {rating && rank <= 10 && <Vote hit={hit} rank={rank} info={info} rating={rating} />}
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
    if (ranked) return ranked.map((f) => ({ path: f.path, score: f.score, funcs: f.functions, count: f.count }));
    const byPath = new Map<string, { path: string; score: number; funcs: WireHit[]; count: number }>();
    for (const h of hits) {
      const f = byPath.get(h.path) ?? { path: h.path, score: -Infinity, funcs: [], count: 0 };
      f.score = Math.max(f.score, h.score);
      f.funcs.push(h);
      f.count++;
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
              <span class="path">{f.count ? `${f.count} candidate function${f.count > 1 ? "s" : ""}` : "named in the issue or close in meaning"}</span>
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
function ResultList({ results, info, view, rating }: { results: Results; info: RepoInfo; view: "functions" | "files"; rating: Rating | null }) {
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
  const noWordMatched = results.hits.every((h) => h.bm25 <= 0);
  return (
    <>
      {noWordMatched && (
        <p class="note no-match">None of these words appear in the code, so these are only the functions closest in meaning. Try names from the code, an error message or a parameter.</p>
      )}
      <ol class="hits" aria-live="polite" ref={list} onKeyDown={onKey}>
        {results.hits.slice(0, shown).map((h, i) => (
          <HitRow key={h.id} hit={h} rank={i + 1} info={info} terms={results.terms} open={openIds.has(h.id)} onToggle={() => toggle(h.id)} rating={rating} />
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
  const [query, setQueryText] = useState(request.get("q") ?? "");
  const [source, setSource] = useState<QuerySource>(request.get("q") != null ? "link" : "typed");
  const [issueUrl, setIssueUrl] = useState<string | null>(null);
  const [issueNote, setIssueNote] = useState<{ text: string; url: string | null } | null>(null);
  const issuePending = useRef(false);
  const setQuery = (text: string | ((q: string) => string), from: QuerySource = "typed", issue: string | null = null) => {
    setQueryText(text);
    setSource(from);
    setIssueUrl(issue);
    if (from !== "link") {
      issuePending.current = false;
      setIssueNote(null);
    }
  };
  const recorded = useRef<Set<string>>(new Set());
  const [semanticOn, setSemanticOn] = useState(true);
  const [serverOn, setServerOn] = useState<boolean>(() => load("gpuRerank", true));
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

  const loadingInput = useRef<string | null>(null);
  const loadedTests = useRef(false);
  const start = (input: string, tests = includeTests) => {
    setIssues(null);
    loadingInput.current = input.trim().toLowerCase();
    loadedTests.current = tests;
    w.load(input, tests);
  };

  const importIssue = (repoInputText: string, issue: string) => {
    let repo: string;
    try {
      const r = parseRepo(repoInputText);
      repo = `${r.owner}/${r.name}`;
    } catch {
      return;
    }
    const url = `https://github.com/${repo}/issues/${issue}`;
    issuePending.current = true;
    setIssueNote({ text: `Fetching issue #${issue} from GitHub…`, url: null });
    githubApi(`/repos/${repo}/issues/${issue}`)
      .then((r) => (r.ok ? (r.json() as Promise<GitIssue>) : Promise.reject(new Error(String(r.status)))))
      .then((i) => {
        issuePending.current = false;
        setQuery(`${i.title}\n\n${(i.body ?? "").slice(0, 1500)}`, "issue", i.html_url);
      })
      .catch((err: unknown) => {
        const status = err instanceof Error ? err.message : "";
        const why = status === "403" || status === "429" ? "GitHub's hourly limit for your network is used up"
          : status === "404" ? "it doesn't exist or isn't public"
          : "GitHub couldn't be reached";
        setIssueNote({ text: `Couldn't fetch issue #${issue}: ${why}. Paste its text into the box above:`, url });
      });
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
    if (request.get("q") != null) setQuery(request.get("q")!, "link");
    start(repo);
    const fromLink = issue && /^\d+$/.test(issue) ? issue : issueNumber(repo);
    if (fromLink) importIssue(repo, fromLink);
  }, [active, request]);

  // A repository finished loading: remember it and offer an example query.
  useEffect(() => {
    if (!info) return;
    const list = [info.repo, ...recent.filter((r) => r.toLowerCase() !== info.repo.toLowerCase())].slice(0, 6);
    setRecent(list);
    save("recentRepos", list);
    if (!query && !issuePending.current && PRESETS[info.repo]) setQuery(PRESETS[info.repo][0], "preset");
  }, [info]);

  const session = useMemo(() => newSession(), [query, info?.repo]);
  const rating: Rating | null = feedbackEnabled && w.results ? { session, stage: w.results.stage, issue: issueUrl } : null;

  useEffect(() => {
    if (!feedbackEnabled || !info || info.partial || !w.results || !query.trim()) return;
    const stage = w.results.stage;
    const t = setTimeout(() => {
      if (recorded.current.has(session)) return;
      recorded.current.add(session);
      recordSearch(info.repo, source, stage, session);
    }, 4000);
    return () => clearTimeout(t);
  }, [w.results, session]);

  useEffect(() => w.preferGpu(serverOn && semanticOn), [serverOn, semanticOn]);

  useEffect(() => {
    if (serverOn && semanticOn && w.serverReady) w.warm();
  }, [w.loading, serverOn, semanticOn, w.serverReady]);

  // The one place searches start from: typing, chips, the semantic switch and new repositories.
  useEffect(() => {
    if (!info) return;
    const t = setTimeout(() => w.search(query, semanticOn, serverOn && semanticOn), 250);
    return () => clearTimeout(t);
  }, [query, semanticOn, serverOn, info, w.semanticIndex?.state]); // re-ranks when the semantic index is ready

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
    const issue = issueNumber(repoInput);
    if (w.loading && repoInput.trim().toLowerCase() === loadingInput.current) return;
    try {
      const r = parseRepo(repoInput);
      const same = info && `${r.owner}/${r.name}`.toLowerCase() === info.repo.toLowerCase() && !r.ref;
      if (same && !w.loading && loadedTests.current === includeTests) {
        if (issue) importIssue(repoInput, issue);
        return queryBox.current?.focus();
      }
    } catch {
      /* invalid input: the loader explains */
    }
    setQuery("");
    start(repoInput);
    if (issue) importIssue(repoInput, issue);
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
        const r = await githubApi(`/repos/${info.repo}/issues?state=open&per_page=30&sort=comments${labels}`);
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
  const semanticStatus = w.semantic ? `${w.semantic}${w.backend && w.semantic.startsWith("Reranked") ? ` · ${w.backend === "webgpu" ? "GPU" : "CPU"}` : ""}` : "";

  return (
    <div class="container app" id="search-app">
      <PageHero kicker="Search" title="Search a repository">
        <p>Downloads a public Python repository into this tab, parses it with Tree-sitter (WebAssembly) and ranks every function against your bug report with learned rankers. The search runs entirely in this tab: your bug report is never sent anywhere.</p>
      </PageHero>

      <form class="card frame repo-card" onSubmit={submit}>
        <label class="field-label" for="repo-input">Repository</label>
        <div class="input-row">
          <input id="repo-input" type="text" value={repoInput} onInput={(e) => setRepoInput(e.currentTarget.value)}
            placeholder="owner/name or a GitHub link" autoComplete="off" spellcheck={false} />
          <button class="btn primary" type="submit" disabled={!repoInput.trim()}>{w.loading && repoInput.trim().toLowerCase() === loadingInput.current ? <><Seer size="sm" />Loading…</> : "Load"}</button>
        </div>
        <div class="row-between">
          <div class="chips">
            {chips.map((name) => (
              <button key={name} class={`chip${recent.includes(name) ? " recent" : ""}`} type="button" onClick={() => pick(name)}
                title={recent.includes(name) ? "Recently searched" : undefined}>{name}</button>
            ))}
          </div>
          <label class="switch">
            <input type="checkbox" checked={includeTests} onChange={(e) => {
              const tests = e.currentTarget.checked;
              setIncludeTests(tests);
              if (info && !w.loading) start(repoInput.trim() || info.repo, tests);
            }} />
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
              <span class="muted">{info.fromCache ? "from your browser's cache" : `ready in ${duration(info.timings.loadMs)}`}</span>
            )}
            {!info.partial && w.semanticIndex && (
              <span class="muted" title="Every function embedded with a static code model, for search by meaning">
                {w.semanticIndex.state === "building" ? <Seer size="sm" text="building the semantic index…" /> : w.semanticIndex.state === "ready" ? `· semantic index ready in ${duration(w.semanticIndex.ms)}` : "· semantic index unavailable"}
              </span>
            )}
            {info.notes.map((n) => <span class="note" key={n}>{n}</span>)}
          </div>

          <div class="card frame query-card">
            <label class="field-label" for="demo-query">Bug report</label>
            <textarea ref={queryBox} id="demo-query" value={query} onInput={(e) => setQuery(e.currentTarget.value)}
              onFocus={() => serverOn && semanticOn && w.serverReady && w.warm()}
              rows={Math.min(10, Math.max(3, query.split("\n").length))}
              placeholder="Paste an issue or a traceback, or describe what goes wrong… (press / to focus)" aria-label="Bug report" />
            {issueNote && (
              <p class="note issue-note" role="status">
                {issueNote.text}
                {issueNote.url && <> <a href={issueNote.url} target="_blank" rel="noopener">open the issue on GitHub ↗</a></>}
              </p>
            )}
            <div class="chips">
              {(PRESETS[info.repo] ?? []).map((ex) => <button key={ex} class="chip preset" type="button" title={ex} onClick={() => setQuery(ex, "preset")}>{ex}</button>)}
              {issues == null && <button class="chip accent" type="button" onClick={fetchIssues}>Use an open issue from {info.repo}</button>}
              {issues === "loading" && <span class="muted small">Fetching open issues…</span>}
              {typeof issues === "string" && issues !== "loading" && <span class="muted small">{issues}</span>}
              {Array.isArray(issues) && issues.map((i) => (
                <button key={i.number} class="chip issue" type="button" title={i.html_url}
                  onClick={() => setQuery(`${i.title}\n\n${(i.body ?? "").slice(0, 1500)}`, "issue", i.html_url)}>#{i.number} {i.title}</button>
              ))}
            </div>
            <div class="toolbar">
              <Seg small label="Result granularity" value={view} onChange={setView} options={[["functions", "Functions"], ["files", "Files"]] as const} />
              <label class="switch" hidden={!w.stages?.rerank} title="Re-read the top candidates with a small language model (downloaded once, then cached)">
                <input type="checkbox" checked={semanticOn} onChange={(e) => setSemanticOn(e.currentTarget.checked)} />
                <span class="track" aria-hidden="true" />Language-model rerank
              </label>
              <label class="switch" hidden={!w.stages?.rerank || !w.serverReady || !semanticOn}
                title="Send the bug report and the top 50 functions to Odin's GPU server, where its fine-tuned reranker re-reads them">
                <input type="checkbox" checked={serverOn} onChange={(e) => { const on = e.currentTarget.checked; setServerOn(on); save("gpuRerank", on); }} />
                <span class="track" aria-hidden="true" />GPU reranker
              </label>
              <span class="toolbar-links push">
                <button class={`link-btn${showMap ? " on" : ""}`} type="button" aria-pressed={showMap} onClick={() => setShowMap(!showMap)}
                  title="The repository as a tree, with the results lit up">{showMap ? "Hide the map" : "Show the map"}</button>
                <button class="link-btn" type="button" onClick={share}>{copied ? "Link copied ✓" : "Copy link"}</button>
              </span>
            </div>
          </div>

          <div class="result-meta">
            <p class="tokens" role="status" aria-live="polite">{semanticStatus.includes("…") && <Seer size="sm" />} {semanticStatus}</p>
            {w.server && <p class="tokens" role="status" aria-live="polite">{w.server.endsWith("…") && <Seer size="sm" />} {w.server}</p>}
            {w.results && (
              <p class="tokens">
                {(w.results.stage === "instant" || w.results.stage === "semantic") && `${w.results.stage === "semantic" ? "Semantic" : "Instant"} ranking of ${info.units.toLocaleString()} functions in ${w.results.ms.toFixed(0)} ms · `}
                terms: {w.results.terms.slice(0, 24).map((t) => <span key={t}>{t}</span>)}
              </p>
            )}
          </div>
          {showMap && (
            RepoMap && w.map ? <RepoMap files={w.map} hits={w.results?.hits.slice(0, 10).map((h) => h.path) ?? []} onPick={toResult} />
              : <p class="muted small">{info.partial ? "The map is drawn once the repository finishes loading." : "Drawing the map…"}</p>
          )}
          {w.results ? <ResultList results={w.results} info={info} view={view} rating={rating} /> : query.trim() ? <Skeleton /> : null}
          <p class="fineprint">
            How accurate is this? <a href={href("benchmarks")}>See the benchmarks</a>.
            {feedbackEnabled && " Searches are counted by repository, and 👍/👎 records the function you rated and its rank. If it came from a public GitHub issue, that issue's link is kept with your vote."}
            {w.serverReady && semanticOn && serverOn
              ? " With the GPU reranker on, your bug report and the top 50 functions are sent to Odin's server to be scored; only the scores are kept, for a day, under a hash of the request."
              : " Your bug report never leaves this tab."}
          </p>
        </>
      )}
    </div>
  );
}
