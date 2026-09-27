// Small, dependency-free helpers the page needs without pulling in the parser.

export interface RepoRef {
  owner: string;
  name: string;
  ref: string | null;
}

export class LoadError extends Error {
  readonly cancelled: boolean;
  readonly rateLimited: boolean;
  constructor(message: string, { cancelled = false, rateLimited = false } = {}) {
    super(message);
    this.cancelled = cancelled;
    this.rateLimited = rateLimited;
  }
}

export function parseRepo(input: string): RepoRef {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?(?:github\.com\/)?([\w.-]+)\/([\w.-]+)(?:\/tree\/([^?#]+))?(?:@([^/]+))?$/);
  if (!m) throw new LoadError("Enter a GitHub repository like owner/name or https://github.com/owner/name");
  return { owner: m[1], name: m[2], ref: m[3] ?? m[4] ?? null };
}

export const githubUrl = (repo: string, branch: string, unit: { path: string; line: number }): string =>
  `https://github.com/${repo}/blob/${encodeURIComponent(branch)}/${unit.path}#L${unit.line}`;

/** Test files, as in odin/index/snapshot.py::_is_test_path (they crowd out source code). */
export function isTestPath(path: string): boolean {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  return name.startsWith("test_") || name.endsWith("_test.py") || name === "conftest.py"
    || parts.slice(0, -1).some((p) => p === "tests" || p === "test" || p === "testing");
}
