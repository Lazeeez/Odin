// Small, dependency-free helpers the page needs without pulling in the parser.

export interface RepoRef {
  owner: string;
  name: string;
  ref: string | null;
}

export class LoadError extends Error {
  readonly cancelled: boolean;
  /** GitHub's API refused or could not be reached: a mirror may still work. */
  readonly useMirror: boolean;
  constructor(message: string, { cancelled = false, useMirror = false } = {}) {
    super(message);
    this.cancelled = cancelled;
    this.useMirror = useMirror;
  }
}

/**
 * Anything people paste for a repository: owner/name, https or ssh URLs, .git suffixes, links to
 * a branch or folder (/tree/<ref>/<dir>), a file (/blob/...), or any page inside the repo
 * (/issues/12, /pull/3). For /tree/ links the branch/folder split is resolved when listing,
 * because branch names can contain slashes.
 */
export function parseRepo(input: string): RepoRef {
  const s = input
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/^(?:git\+)?(?:https?|ssh|git):\/\/(?:git@)?/i, "")
    .replace(/^(?:www\.)?github\.com\//i, "")
    .replace(/\/+$/, "");
  const m = s.match(/^([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:@([^\s/]+))?(?:\/(?:tree|blob)\/(\S+)|\/(?!tree\/|blob\/)\S*)?$/);
  // Another host (gitlab.com/a/b) would otherwise read as owner "gitlab.com".
  if (!m || /\.(com|org|io|net)$/i.test(m[1])) {
    throw new LoadError("Enter a GitHub repository like owner/name or https://github.com/owner/name");
  }
  let ref = m[4] ?? m[3] ?? null;
  // A /blob/ link names a file: keep only its branch part (the file's folder is not a scope).
  if (ref && /\/blob\//.test(s)) ref = ref.split("/")[0];
  return { owner: m[1], name: m[2], ref: ref ? decodeURIComponent(ref) : null };
}

const GITHUB_PROXY = ((import.meta.env.VITE_GITHUB_PROXY as string | undefined) ?? "").replace(/\/+$/, "");
let proxyConfigured = GITHUB_PROXY !== "";

export async function githubApi(path: string): Promise<Response> {
  if (proxyConfigured) {
    const r = await fetch(`${GITHUB_PROXY}${path}`).catch(() => null);
    if (r?.status === 501) proxyConfigured = false;
    else if (r && r.status !== 502 && r.status !== 503 && r.status !== 429) return r;
  }
  return fetch(`https://api.github.com${path}`);
}

export function issueNumber(input: string): string | null {
  return input.match(/(?:^|github\.com\/)[\w.-]+\/[\w.-]+\/(?:issues|pull)\/(\d+)/i)?.[1] ?? null;
}

/** A path or ref as URL segments: spaces, "#" and non-ASCII escaped, slashes kept. */
export const encodePath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

export const githubUrl = (repo: string, branch: string, unit: { path: string; line: number }): string =>
  `https://github.com/${repo}/blob/${encodePath(branch)}/${encodePath(unit.path)}#L${unit.line}`;

/** Test files, as in odin/index/snapshot.py::_is_test_path (they crowd out source code). */
export function isTestPath(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  return name.startsWith("test_") || name.endsWith("_test.py") || name === "conftest.py"
    || parts.slice(0, -1).some((p) => p === "tests" || p === "test" || p === "testing");
}
