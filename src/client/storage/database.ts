import type { Index } from '../indexed.js';
import {
  isIndexEqual,
  META_STORE,
  normalizeKeyPath,
  OUTBOX_STORE,
} from './utils.js';

export async function openIndexedDatabase(name: string): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => {
      createInternalStores(request.result);
    };
    request.onsuccess = () => {
      const database = request.result;
      if (
        !database.objectStoreNames.contains(OUTBOX_STORE) ||
        !database.objectStoreNames.contains(META_STORE)
      ) {
        const nextVersion = database.version + 1;
        upgradeIndexedDatabase(name, database, nextVersion, [], new Map())
          .then(resolve)
          .catch(reject);
      } else {
        resolve(database);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

export async function upgradeIndexedDatabase(
  name: string,
  currentDb: IDBDatabase,
  nextVersion: number,
  newTables: string[],
  registeredIndexes: Map<string, Index[]>,
): Promise<IDBDatabase> {
  currentDb.close();
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, nextVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      const tx = request.transaction;
      createInternalStores(database);

      const allTableNames = new Set([
        ...newTables,
        ...registeredIndexes.keys(),
      ]);

      for (const tableName of allTableNames) {
        if (!database.objectStoreNames.contains(tableName)) {
          database.createObjectStore(tableName, { keyPath: 'id' });
        }
      }

      for (const [tableName, desiredIndexes] of registeredIndexes) {
        if (!tx) continue;
        const store = tx.objectStore(tableName);
        const desiredMap = new Map(
          desiredIndexes.map((idx) => [idx.name, idx]),
        );

        for (let i = store.indexNames.length - 1; i >= 0; i--) {
          const indexName = store.indexNames[i];
          const desired = desiredMap.get(indexName);
          if (!desired || !isIndexEqual(store.index(indexName), desired)) {
            store.deleteIndex(indexName);
          }
        }

        for (const desired of desiredIndexes) {
          if (!store.indexNames.contains(desired.name)) {
            store.createIndex(desired.name, normalizeKeyPath(desired.keyPath), {
              unique: desired.unique,
              multiEntry: desired.multiEntry,
            });
          }
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function createInternalStores(db: IDBDatabase): void {
  if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
    db.createObjectStore(OUTBOX_STORE, {
      keyPath: 'localId',
      autoIncrement: true,
    });
  }
  if (!db.objectStoreNames.contains(META_STORE)) {
    db.createObjectStore(META_STORE, { keyPath: 'key' });
  }
}
