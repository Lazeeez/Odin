// A tiny IndexedDB key-value store. Every call degrades to "no cache" instead of failing:
// private browsing, a full disk or a missing API must never break search.
const DB_NAME = "odin-lite";
const STORES = ["repos", "vectors"] as const;
export type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase | null> | null = null;

function open(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
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

async function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => () => T): Promise<T | undefined> {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(store, mode);
      const result = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(result());
      tx.onerror = tx.onabort = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

export function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  return run(store, "readonly", (s) => {
    const req = s.get(key);
    return () => req.result as T | undefined;
  });
}

export async function idbGetMany<T>(store: StoreName, keys: string[]): Promise<(T | undefined)[]> {
  const out = await run(store, "readonly", (s) => {
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
  await run(store, "readwrite", (s) => {
    s.put(value, key);
    return () => undefined;
  });
}

export async function idbPutMany(store: StoreName, entries: [string, unknown][]): Promise<void> {
  await run(store, "readwrite", (s) => {
    for (const [k, v] of entries) s.put(v, k);
    return () => undefined;
  });
}
