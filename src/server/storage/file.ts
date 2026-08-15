import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { shouldOverwrite } from '../../shared/clock.js';
import {
  type ChangeRecord,
  OperationType,
  type RecordSnapshotItem,
  type StoredRecord,
} from '../../shared/types.js';
import type { StorageAdapter } from './adapter.js';

interface UserMeta {
  currentSeq: number;
}

/**
 * Options for configuring the filesystem storage adapter.
 */
export interface FileStorageOptions {
  /** Root directory on the filesystem where user data folders will be stored. */
  baseDir: string;
}

/**
 * Filesystem-backed storage adapter organizing data into per-user subdirectories
 * (`<baseDir>/<userId>/stores/<storeName>.json` and `<baseDir>/<userId>/changelog.json`).
 */
export class FileStorageAdapter implements StorageAdapter {
  private baseDir: string;
  private userLocks: Map<string, Promise<unknown>> = new Map();
  // In-memory cache for speed and consistency
  private userCache: Map<
    string,
    {
      currentSeq: number;
      stores: Map<string, Map<string, StoredRecord>>;
      changelog: Array<ChangeRecord & { seq: number }>;
      loaded: boolean;
    }
  > = new Map();

  /**
   * Initializes a new FileStorageAdapter.
   *
   * @param options - Filesystem storage options specifying baseDir.
   */
  constructor(options: FileStorageOptions) {
    this.baseDir = path.resolve(options.baseDir);
  }

  private async withUserLock<T>(
    userId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prevLock = this.userLocks.get(userId) ?? Promise.resolve();
    let resolveLock: (() => void) | undefined;
    const newLock = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    this.userLocks.set(userId, newLock);

    try {
      await prevLock;
      return await fn();
    } finally {
      resolveLock?.();
      if (this.userLocks.get(userId) === newLock) {
        this.userLocks.delete(userId);
      }
    }
  }

  private getUserDir(userId: string): string {
    // Sanitize userId to prevent directory traversal
    const safeUserId = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.baseDir, safeUserId);
  }

  private async loadUser(userId: string) {
    let cached = this.userCache.get(userId);
    if (cached?.loaded) return cached;

    cached = {
      currentSeq: 0,
      stores: new Map(),
      changelog: [],
      loaded: true,
    };

    const userDir = this.getUserDir(userId);
    await fs.mkdir(path.join(userDir, 'stores'), { recursive: true });

    // Read meta.json
    try {
      const metaRaw = await fs.readFile(
        path.join(userDir, 'meta.json'),
        'utf-8',
      );
      const meta: UserMeta = JSON.parse(metaRaw);
      cached.currentSeq = meta.currentSeq ?? 0;
    } catch {
      // meta.json doesn't exist yet
    }

    // Read stores
    try {
      const storesDir = path.join(userDir, 'stores');
      const files = await fs.readdir(storesDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const storeName = path.basename(file, '.json');
          const content = await fs.readFile(
            path.join(storesDir, file),
            'utf-8',
          );
          const recordsObj: Record<string, StoredRecord> = JSON.parse(content);
          const map = new Map<string, StoredRecord>(Object.entries(recordsObj));
          cached.stores.set(storeName, map);
        }
      }
    } catch {
      // ignore
    }

    // Read changelog.json
    try {
      const changelogRaw = await fs.readFile(
        path.join(userDir, 'changelog.json'),
        'utf-8',
      );
      cached.changelog = JSON.parse(changelogRaw);
    } catch {
      // ignore
    }

    this.userCache.set(userId, cached);
    return cached;
  }

  private async persistUser(userId: string) {
    const cached = this.userCache.get(userId);
    if (!cached) return;

    const userDir = this.getUserDir(userId);
    const storesDir = path.join(userDir, 'stores');
    await fs.mkdir(storesDir, { recursive: true });

    // Save meta.json
    const meta: UserMeta = { currentSeq: cached.currentSeq };
    await fs.writeFile(
      path.join(userDir, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );

    // Save stores
    for (const [storeName, map] of cached.stores.entries()) {
      const obj: Record<string, StoredRecord> = {};
      for (const [id, record] of map.entries()) {
        obj[id] = record;
      }
      await fs.writeFile(
        path.join(storesDir, `${storeName}.json`),
        JSON.stringify(obj, null, 2),
        'utf-8',
      );
    }

    // Save changelog.json
    await fs.writeFile(
      path.join(userDir, 'changelog.json'),
      JSON.stringify(cached.changelog, null, 2),
      'utf-8',
    );
  }

  /**
   * Retrieves a single stored record by table and identifier for a user from filesystem storage.
   *
   * @param userId - Target user account identifier.
   * @param store - Table/store name.
   * @param id - Record identifier.
   * @returns Stored record or `undefined` if not found.
   */
  async getRecord(
    userId: string,
    store: string,
    id: string,
  ): Promise<StoredRecord | undefined> {
    return this.withUserLock(userId, async () => {
      const user = await this.loadUser(userId);
      const storeMap = user.stores.get(store);
      return storeMap?.get(id);
    });
  }

  /**
   * Retrieves all non-deleted records for a user across all tables (or a specific table).
   *
   * @param userId - Target user account identifier.
   * @param store - Optional table name to filter.
   * @returns Array of snapshot items.
   */
  async getAllRecords(
    userId: string,
    store?: string,
  ): Promise<RecordSnapshotItem[]> {
    return this.withUserLock(userId, async () => {
      const user = await this.loadUser(userId);
      const items: RecordSnapshotItem[] = [];

      const storesToIterate = store ? [store] : Array.from(user.stores.keys());
      for (const s of storesToIterate) {
        const storeMap = user.stores.get(s);
        if (!storeMap) continue;
        for (const [id, record] of storeMap.entries()) {
          if (!record.deleted) {
            items.push({
              store: s,
              id,
              data: record.data,
              timestamp: record.timestamp,
              version: record.version,
              deleted: false,
            });
          }
        }
      }

      return items;
    });
  }

  /**
   * Applies an array of mutation change operations, assigns sequence numbers,
   * updates the local cache, and persists updates to the user's directory on disk.
   *
   * @param userId - Target user account identifier.
   * @param changes - Array of change records to apply.
   * @returns Object with applied changes and new sequence number.
   */
  async applyChanges(
    userId: string,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    return this.withUserLock(userId, async () => {
      const user = await this.loadUser(userId);
      const applied: ChangeRecord[] = [];

      for (const change of changes) {
        let storeMap = user.stores.get(change.store);
        if (!storeMap) {
          storeMap = new Map();
          user.stores.set(change.store, storeMap);
        }

        const existing = storeMap.get(change.id);
        if (shouldOverwrite(change, existing)) {
          user.currentSeq += 1;
          const seq = user.currentSeq;

          const isDelete =
            change.op === OperationType.Delete || Boolean(change.deleted);
          const record: StoredRecord = {
            id: change.id,
            data: change.data,
            timestamp: change.timestamp,
            version: (existing?.version ?? 0) + 1,
            deleted: isDelete,
          };

          storeMap.set(change.id, record);

          const appliedChange: ChangeRecord & { seq: number } = {
            ...change,
            seq,
            version: record.version,
            deleted: isDelete,
          };

          user.changelog.push(appliedChange);
          applied.push(appliedChange);
        }
      }

      if (applied.length > 0) {
        await this.persistUser(userId);
      }

      return { applied, newSeq: user.currentSeq };
    });
  }

  /**
   * Retrieves all changes applied since the given sequence number for a user.
   *
   * @param userId - Target user account identifier.
   * @param fromSeq - Starting sequence number (exclusive).
   * @returns Object with change records and current sequence number.
   */
  async getChangesSince(
    userId: string,
    fromSeq: number,
  ): Promise<{ changes: ChangeRecord[]; currentSeq: number }> {
    return this.withUserLock(userId, async () => {
      const user = await this.loadUser(userId);
      const changes = user.changelog.filter((c) => (c.seq ?? 0) > fromSeq);
      return {
        changes,
        currentSeq: user.currentSeq,
      };
    });
  }

  /**
   * Retrieves the current global sequence number for a user from metadata.
   *
   * @param userId - Target user account identifier.
   * @returns Current integer sequence number.
   */
  async getCurrentSeq(userId: string): Promise<number> {
    return this.withUserLock(userId, async () => {
      const user = await this.loadUser(userId);
      return user.currentSeq;
    });
  }

  /**
   * Clears the in-memory cache.
   */
  async close(): Promise<void> {
    this.userCache.clear();
  }
}
