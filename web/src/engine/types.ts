export type UnitKind = "function" | "method" | "class";

/** A retrieval unit as the chunker produces it: the same units ground truth is labelled with. */
export interface Chunk {
  qualname: string;
  kind: UnitKind;
  /** 1-based first line in the file (a decorator, if any). */
  line: number;
  text: string;
}

export interface Unit extends Chunk {
  path: string;
  /** "path::Qualified.name", the id used throughout the project. */
  id: string;
}

export interface Hit {
  unit: Unit;
  score: number;
  bm25?: number;
  semantic?: number;
}

export interface SearchResult {
  hits: Hit[];
  terms: string[];
}
