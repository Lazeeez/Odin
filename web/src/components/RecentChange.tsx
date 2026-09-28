import { useEffect, useState } from "preact/hooks";

interface Commit { sha: string; html_url: string; commit: { message: string; author: { name: string; date: string } } }

// One request per file and session: GitHub allows 60 unauthenticated API calls an hour.
const cache = new Map<string, Promise<Commit | null>>();

function lastCommit(repo: string, ref: string, path: string): Promise<Commit | null> {
  const key = `${repo}@${ref}:${path}`;
  let p = cache.get(key);
  if (!p) {
    const sha = ref && ref !== "HEAD" ? `&sha=${encodeURIComponent(ref)}` : "";
    p = fetch(`https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=1${sha}`)
      .then((r) => (r.ok ? (r.json() as Promise<Commit[]>) : []))
      .then((list) => list[0] ?? null, () => null);
    cache.set(key, p);
  }
  return p;
}

const ago = (date: string) => {
  const days = Math.floor((Date.now() - Date.parse(date)) / 86_400_000);
  if (days < 1) return "today";
  if (days < 60) return `${days} day${days === 1 ? "" : "s"} ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
};

/**
 * When the file behind a result last changed, from GitHub's commit history. Recently changed code
 * is a common place for a new bug, so changes within 30 days are marked.
 */
export function RecentChange({ repo, reference, path }: { repo: string; reference: string; path: string }) {
  const [c, setC] = useState<Commit | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    lastCommit(repo, reference, path).then((x) => live && setC(x));
    return () => { live = false; };
  }, [repo, reference, path]);
  if (!c) return null;
  const recent = Date.now() - Date.parse(c.commit.author.date) < 30 * 86_400_000;
  return (
    <div class={`recent-change${recent ? " hot" : ""}`}>
      {recent && <span class="badge-mini rescue">recently changed</span>}
      <span>File last changed {ago(c.commit.author.date)} by {c.commit.author.name}:</span>
      <a href={c.html_url} target="_blank" rel="noopener">{c.commit.message.split("\n")[0].slice(0, 90)}</a>
    </div>
  );
}
