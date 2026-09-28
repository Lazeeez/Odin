// Static embeddings in the browser: the port of odin/search/static.py. A text's vector is the
// mean of its tokens' vectors, so a whole repository embeds in seconds with no neural network.
// The tokenizer is BERT's (uncased WordPiece), reimplemented here so it is fast and exact:
// tests/test_site_engine.py compares token ids and vectors with the Python side.

export interface StaticModel {
  vocab: Map<string, number>;
  unk: number;
  pad: number;
  dim: number;
  maxTokens: number;
  /** Token vectors, int8, one row per vocabulary entry, with one float scale per row. */
  table: Int8Array;
  scales: Float32Array;
}

// "Other" in Unicode terms (Rust's is_other): control, format, unassigned, private use, surrogate.
const CONTROL = /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}]/u;
const PUNCT = /[\p{P}]/u;
const MARK = /\p{Mn}/gu;
const isWhitespace = (c: string) => /\s/u.test(c);
const isPunct = (cp: number, c: string) => (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126) || PUNCT.test(c);
const isCjk = (cp: number) =>
  (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) || (cp >= 0x2a700 && cp <= 0x2b73f) ||
  (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);

// ASCII fast path (nearly all code): 0 keep, 1 drop (control), 2 whitespace, 3 punctuation.
const ASCII = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  if (c === 9 || c === 10 || c === 13 || c === 32) ASCII[c] = 2;
  else if (c < 32 || c === 127) ASCII[c] = 1;
  else if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) ASCII[c] = 3;
}

/**
 * BERT normalizer (clean text, CJK spacing, strip accents, lowercase) and pre-tokenizer, as a
 * generator so tokenizing can stop at the token limit instead of reading the whole text.
 */
export function* bertWords(text: string): Generator<string> {
  let cur = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp < 128) {
      const k = ASCII[cp];
      if (k === 0) cur += cp >= 65 && cp <= 90 ? String.fromCharCode(cp + 32) : ch;
      else if (k === 2) {
        if (cur) yield cur;
        cur = "";
      } else if (k === 3) {
        if (cur) yield cur;
        cur = "";
        yield ch;
      }
      continue;
    }
    // Same order as the Rust normalizer: drop controls first, then split on whitespace.
    if (cp === 0xfffd || CONTROL.test(ch)) continue;
    if (isWhitespace(ch)) {
      if (cur) yield cur;
      cur = "";
      continue;
    }
    // Accents stripped (NFD, drop combining marks) and lowercased, as BertNormalizer does.
    for (const c of ch.normalize("NFD").replace(MARK, "").toLowerCase()) {
      const p = c.codePointAt(0)!;
      if (isPunct(p, c) || isCjk(p)) {
        if (cur) yield cur;
        cur = "";
        yield c;
      } else cur += c;
    }
  }
  if (cur) yield cur;
}

// "[PAD]" in text is that special token when it stands as a whole word (any case), as in the
// Rust tokenizer; unlike [UNK] it is kept.
const PAD_WORD = /(?<![\p{L}\p{N}_])\[pad\](?![\p{L}\p{N}_])/giu;

/**
 * WordPiece token ids with [UNK] dropped (as Model2Vec does), counting like the Rust tokenizer:
 * the literal "[UNK]" in raw text is that token, and truncation at `max` counts [UNK]s too.
 */
export function wordPieceIds(text: string, vocab: Map<string, number>, unk: number, max: number, pad = -1): number[] {
  const out: number[] = [];
  let seen = 0;
  const words = function* (): Generator<number | string> {
    const segments = text.split("[UNK]");
    for (let si = 0; si < segments.length; si++) {
      if (si > 0) yield unk; // the literal [UNK] between segments
      const seg = segments[si];
      if (pad < 0 || !/\[pad\]/i.test(seg)) {
        yield* bertWords(seg);
        continue;
      }
      let at = 0;
      for (const m of seg.matchAll(PAD_WORD)) {
        yield* bertWords(seg.slice(at, m.index));
        yield pad;
        at = m.index + m[0].length;
      }
      yield* bertWords(seg.slice(at));
    }
  };
  for (const word of words()) {
    let pieces: number[] | null;
    if (typeof word === "number") pieces = [word];
    else {
      const chars = [...word];
      pieces = chars.length > 100 ? null : [];
      let start = 0;
      while (pieces && start < chars.length) {
        let end = chars.length;
        let id: number | undefined;
        while (start < end) {
          id = vocab.get((start > 0 ? "##" : "") + chars.slice(start, end).join(""));
          if (id !== undefined) break;
          end--;
        }
        if (id === undefined) pieces = null;
        else {
          pieces.push(id);
          start = end;
        }
      }
    }
    // A word WordPiece cannot split is one [UNK]: counted, not kept.
    for (const id of pieces ?? [unk]) {
      if (id !== unk) out.push(id);
      if (++seen >= max) return out;
    }
  }
  return out;
}

/** L2-normalized mean of the token vectors; all zeros when no token is known. */
export function embedText(model: StaticModel, text: string): Float32Array {
  const ids = wordPieceIds(text, model.vocab, model.unk, model.maxTokens, model.pad);
  const { dim, table, scales } = model;
  const v = new Float32Array(dim);
  for (const id of ids) {
    const s = scales[id];
    const row = id * dim;
    for (let j = 0; j < dim; j++) v[j] += table[row + j] * s;
  }
  let norm = 0;
  for (let j = 0; j < dim; j++) norm += v[j] * v[j];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let j = 0; j < dim; j++) v[j] /= norm;
  return v;
}

/**
 * The model file written by scripts/browser_ltr.py: a little-endian uint32 header length, a
 * JSON header {dim, maxTokens, unk, vocab: [...tokens]}, then float32 scales and int8 rows.
 */
export function parseStaticModel(buf: ArrayBuffer): StaticModel {
  const view = new DataView(buf);
  const headerLen = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen))) as {
    dim: number; maxTokens: number; unk: number; pad?: number; vocab: string[];
  };
  let at = 4 + headerLen;
  at += (4 - (at % 4)) % 4; // scales are 4-byte aligned
  const n = header.vocab.length;
  const scales = new Float32Array(buf, at, n);
  const table = new Int8Array(buf, at + 4 * n, n * header.dim);
  const vocab = new Map(header.vocab.map((t, i) => [t, i]));
  return { vocab, unk: header.unk, pad: header.pad ?? -1, dim: header.dim, maxTokens: header.maxTokens, table, scales };
}
