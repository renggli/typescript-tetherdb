import type { Index, IndexQueryOptions } from '../indexed.js';

export const OUTBOX_STORE = '__tether_outbox';
export const META_STORE = '__tether_meta';

const RESERVED_METADATA_FIELDS = new Set([
  'id',
  'timestamp',
  'version',
  'clientId',
  'deleted',
  'userName',
]);

export function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function promisifyTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export function isIndexEqual(existing: IDBIndex, desired: Index): boolean {
  return (
    isKeyPathEqual(existing.keyPath, normalizeKeyPath(desired.keyPath)) &&
    existing.unique === desired.unique &&
    existing.multiEntry === desired.multiEntry
  );
}

export function storeNeedsIndexMigration(
  store: IDBObjectStore,
  desiredIndexes: Index[],
): boolean {
  if (store.indexNames.length !== desiredIndexes.length) return true;
  const desiredMap = new Map(desiredIndexes.map((idx) => [idx.name, idx]));
  for (let i = 0; i < store.indexNames.length; i++) {
    const name = store.indexNames[i];
    const desired = desiredMap.get(name);
    if (!desired || !isIndexEqual(store.index(name), desired)) {
      return true;
    }
  }
  return false;
}

export function isKeyPathEqual(
  a: string | string[],
  b: string | string[],
): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((val, idx) => val === b[idx]);
  }
  return a === b;
}

export function normalizeKeyPath(path: string | string[]): string | string[] {
  if (Array.isArray(path)) {
    return path.map(normalizeSingleKeyPath);
  }
  return normalizeSingleKeyPath(path);
}

function normalizeSingleKeyPath(path: string): string {
  return RESERVED_METADATA_FIELDS.has(path) || path.startsWith('data.')
    ? path
    : `data.${path}`;
}

export function collectFromCursor<R, C extends IDBCursor>(
  req: IDBRequest<C | null>,
  extract: (cursor: C) => R,
  options?: IndexQueryOptions,
): Promise<R[]> {
  const limit = options?.limit;
  const offset = options?.offset ?? 0;
  return new Promise<R[]>((resolve, reject) => {
    const results: R[] = [];
    let advanced = false;
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) {
        resolve(results);
        return;
      }
      if (offset > 0 && !advanced) {
        advanced = true;
        cursor.advance(offset);
        return;
      }
      results.push(extract(cursor));
      if (limit !== undefined && results.length >= limit) {
        resolve(results);
        return;
      }
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
