// A tiny IndexedDB key-value store. Every call degrades to "no cache" instead of failing:
// private browsing, a full disk or a missing API must never break search.
const DB_NAME = "odin-lite";
const STORES = ["repos", "vectors", "meta"] as const;
export type StoreName = (typeof STORES)[number];

/** Parsed repositories kept, least recently used evicted first. */
export const REPO_BUDGET = { repos: 12, bytes: 400e6 };
/** Stored embedding vectors before the store is cleared (they are recomputed on demand). */
export const VECTOR_BUDGET = 400_000;

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

async function run<T>(store: StoreName | StoreName[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => () => T): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const result = fn(tx);
      tx.oncomplete = () => resolve(result());
      tx.onerror = tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  return run(store, "readonly", (tx) => {
    const req = tx.objectStore(store).get(key);
    return () => req.result as T | undefined;
  });
}

export async function idbGetMany<T>(store: StoreName, keys: string[]): Promise<(T | undefined)[]> {
  const out = await run(store, "readonly", (tx) => {
    const s = tx.objectStore(store);
    const values = new Array<T | undefined>(keys.length);
    keys.forEach((k, i) => {
      const req = s.get(k);
      req.onsuccess = () => {
        values[i] = req.result as T | undefined;
      };
    });
    return () => values;
  });
  return out ?? new Array<T | undefined>(keys.length);
}

export async function idbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  await run(store, "readwrite", (tx) => {
    tx.objectStore(store).put(value, key);
    return () => undefined;
  });
}

export async function idbPutMany(store: StoreName, entries: [string, unknown][]): Promise<void> {
  await run(store, "readwrite", (tx) => {
    const s = tx.objectStore(store);
    for (const [k, v] of entries) s.put(v, k);
    return () => undefined;
  });
}

interface RepoMeta {
  at: number;
  bytes: number;
}

/** Record that a cached repository was used (or stored), then evict the least recent ones. */
export async function touchRepo(key: string, bytes?: number): Promise<void> {
  const known = await idbGet<RepoMeta>("meta", `repo|${key}`);
  await idbPut("meta", `repo|${key}`, { at: Date.now(), bytes: bytes ?? known?.bytes ?? 0 } satisfies RepoMeta);
  const all = await run("meta", "readonly", (tx) => {
    const s = tx.objectStore("meta");
    const keys = s.getAllKeys(IDBKeyRange.bound("repo|", "repo|￿"));
    const vals = s.getAll(IDBKeyRange.bound("repo|", "repo|￿"));
    return () => (keys.result as string[]).map((k, i) => [k, vals.result[i] as RepoMeta] as const);
  });
  if (!all) return;
  const newest = [...all].sort((a, b) => b[1].at - a[1].at);
  let bytesKept = 0;
  const evict: string[] = [];
  newest.forEach(([k, m], i) => {
    bytesKept += m.bytes;
    if (i >= REPO_BUDGET.repos || (i > 0 && bytesKept > REPO_BUDGET.bytes)) evict.push(k);
  });
  if (!evict.length) return;
  await run(["meta", "repos"], "readwrite", (tx) => {
    for (const k of evict) {
      tx.objectStore("meta").delete(k);
      tx.objectStore("repos").delete(k.slice("repo|".length));
    }
    return () => undefined;
  });
}

/** Vectors are cheap to recompute: past the budget, start the store afresh. */
export async function trimVectors(): Promise<void> {
  const n = await run("vectors", "readonly", (tx) => {
    const req = tx.objectStore("vectors").count();
    return () => req.result;
  });
  if (n != null && n > VECTOR_BUDGET) {
    await run("vectors", "readwrite", (tx) => {
      tx.objectStore("vectors").clear();
      return () => undefined;
    });
  }
}
