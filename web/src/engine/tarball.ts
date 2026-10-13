// Read a repository archive (.tar.gz) as a stream: one download instead of one request per
// file. GitHub serves archives from codeload.github.com, which other sites may not read, so
// this is used through a small CORS relay (proxy/cloudflare-worker.js) when one is set up.

export interface TarFile {
  /** Path inside the repository (the archive's top-level folder removed). */
  path: string;
  data: Uint8Array;
}

const BLOCK = 512;
const decoder = new TextDecoder();

const str = (b: Uint8Array, start: number, len: number) => {
  const s = b.subarray(start, start + len);
  const end = s.indexOf(0);
  return decoder.decode(end < 0 ? s : s.subarray(0, end));
};
const octal = (b: Uint8Array, start: number, len: number) => parseInt(str(b, start, len).trim() || "0", 8);

/** "len key=value\n" records of a pax extended header. */
function paxPath(data: Uint8Array): string | null {
  const text = decoder.decode(data);
  const m = text.match(/(?:^|\n)\d+ path=([^\n]*)\n/);
  return m ? m[1] : null;
}

function paxCommit(data: Uint8Array): string | null {
  return decoder.decode(data).match(/(?:^|\n)\d+ comment=([0-9a-f]{40})\n/)?.[1] ?? null;
}

export class TruncatedArchive extends Error {}

/**
 * Regular files of a gzipped tar stream, for which `want(path)` is true (others are skipped
 * without being kept). Handles ustar prefixes, pax and GNU long names.
 */
export async function* untar(
  stream: ReadableStream<BufferSource>,
  want: (path: string) => boolean,
  onCommit?: (commit: string) => boolean | Promise<boolean>,
): AsyncGenerator<TarFile> {
  const reader = stream.pipeThrough(new DecompressionStream("gzip")).getReader();
  let buf = new Uint8Array(0);
  let done = false;
  const need = async (n: number): Promise<boolean> => {
    while (buf.length < n && !done) {
      const r = await reader.read();
      if (r.done) done = true;
      else {
        const next = new Uint8Array(buf.length + r.value.length);
        next.set(buf);
        next.set(r.value, buf.length);
        buf = next;
      }
    }
    return buf.length >= n;
  };
  const take = (n: number) => {
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    return out;
  };
  let longName: string | null = null;
  let finished = false;
  while (await need(BLOCK)) {
    const header = take(BLOCK);
    if (header.every((b) => b === 0)) {
      finished = true;
      break;
    }
    const size = octal(header, 124, 12);
    const type = String.fromCharCode(header[156] || 48);
    const padded = Math.ceil(size / BLOCK) * BLOCK;
    if (!(await need(padded))) break;
    const body = take(padded).subarray(0, size);
    if (type === "x" || type === "L") {
      longName = type === "x" ? paxPath(body) : str(body, 0, size);
      continue;
    }
    if (type === "g") {
      const commit = paxCommit(body);
      if (commit && onCommit && !(await onCommit(commit))) {
        finished = true;
        break;
      }
      continue;
    }
    const prefix = str(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${str(header, 0, 100)}` : str(header, 0, 100));
    longName = null;
    if (type !== "0" && type !== "\0") continue; // folders, links: not code
    const path = name.slice(name.indexOf("/") + 1); // drop "<repo>-<sha>/"
    if (path && want(path)) yield { path, data: body.slice() };
  }
  await reader.cancel().catch(() => {});
  if (!finished) throw new TruncatedArchive("the archive ended before its end marker");
}
