import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { shouldOverwrite } from '../../shared/clock.js';
import {
  calculateByteSize,
  validateRecordId,
  validateStoreName,
  validateUserId,
} from '../../shared/sanitize.js';
import {
  type ChangeRecord,
  OperationType,
  type RecordSnapshotItem,
  type ServerLimits,
  type StoredRecord,
} from '../../shared/types.js';
import type { StorageAdapter } from './adapter.js';

interface UserMeta {
  currentSeq: number;
  minSeq?: number;
}

/**
 * Options for configuring the filesystem storage adapter.
 */
export interface FileStorageOptions {
  /** Root directory on the filesystem where user data folders will be stored. */
  baseDir: string;
  /** Optional limits and quota configurations. */
  limits?: ServerLimits;
}

interface UserCacheEntry {
  currentSeq: number;
  minSeq: number;
  stores: Map<string, Map<string, StoredRecord>>;
  changelog: Array<ChangeRecord & { seq: number }>;
  loaded: boolean;
}

/**
 * Filesystem-backed storage adapter organizing data into sharded per-user subdirectories
 * (`<baseDir>/<shard>/<userId>/stores/<storeName>.json` where `<shard> = userId.slice(0, 2)`).
 * Provides path traversal defense, changelog compaction, and quota enforcement.
 */
export class FileStorageAdapter implements StorageAdapter {
  private baseDir: string;
  private limits: ServerLimits;
  private userLocks: Map<string, Promise<unknown>> = new Map();
  private userCache: Map<string, UserCacheEntry> = new Map();

  /**
   * Initializes a new FileStorageAdapter.
   *
   * @param options - Filesystem storage options specifying baseDir and optional limits.
   */
  constructor(options: FileStorageOptions) {
    this.baseDir = path.resolve(options.baseDir);
    this.limits = options.limits ?? {};
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

  /**
   * Computes the sharded directory path for a user with strict path confinement checks.
   *
   * @param userId - Validated user ID.
   * @returns Absolute path to user directory `<baseDir>/<shard>/<userId>`.
   */
  private getUserDir(userId: string): string {
    const safeUserId = validateUserId(userId);
    const shard = safeUserId.slice(0, 2).toLowerCase();
    const userDir = path.resolve(this.baseDir, shard, safeUserId);

    if (!userDir.startsWith(this.baseDir + path.sep)) {
      throw new Error(
        `Path traversal attempt detected for userId: "${userId}"`,
      );
    }
    return userDir;
  }

  /**
   * Computes the absolute file path for a store JSON file with strict path confinement.
   *
   * @param userDir - The user root directory.
   * @param storeName - Store name to validate and resolve.
   * @returns Absolute path to store JSON file.
   */
  private getStoreFilePath(userDir: string, storeName: string): string {
    const safeStoreName = validateStoreName(
      storeName,
      this.limits.allowedStores,
    );
    const storesDir = path.resolve(userDir, 'stores');
    const filePath = path.resolve(storesDir, `${safeStoreName}.json`);

    if (!filePath.startsWith(storesDir + path.sep)) {
      throw new Error(
        `Path traversal attempt detected for store: "${storeName}"`,
      );
    }
    return filePath;
  }

  private async loadUser(userId: string): Promise<UserCacheEntry> {
    let cached = this.userCache.get(userId);
    if (cached?.loaded) return cached;

    cached = {
      currentSeq: 0,
      minSeq: 0,
      stores: new Map(),
      changelog: [],
      loaded: true,
    };

    const userDir = this.getUserDir(userId);
    const storesDir = path.join(userDir, 'stores');
    await fs.mkdir(storesDir, { recursive: true });

    // Read meta.json
    try {
      const metaRaw = await fs.readFile(
        path.join(userDir, 'meta.json'),
        'utf-8',
      );
      const meta: UserMeta = JSON.parse(metaRaw);
      cached.currentSeq = meta.currentSeq ?? 0;
      cached.minSeq = meta.minSeq ?? 0;
    } catch {
      // meta.json doesn't exist yet
    }

    // Read stores
    try {
      const files = await fs.readdir(storesDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const storeName = path.basename(file, '.json');
          try {
            validateStoreName(storeName, this.limits.allowedStores);
          } catch {
            continue; // Skip invalid or non-allowlisted store files
          }
          const content = await fs.readFile(
            path.join(storesDir, file),
            'utf-8',
          );
          const recordsObj: Record<string, StoredRecord> = JSON.parse(content);
          const map = new Map<string, StoredRecord>();
          for (const [key, val] of Object.entries(recordsObj)) {
            if (key !== '__proto__' && key !== 'prototype') {
              map.set(key, val);
            }
          }
          cached.stores.set(storeName, map);
        }
      }
    } catch {
      // ignore directory read errors
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

  private async persistUser(userId: string): Promise<void> {
    const cached = this.userCache.get(userId);
    if (!cached) return;

    const userDir = this.getUserDir(userId);
    const storesDir = path.join(userDir, 'stores');
    await fs.mkdir(storesDir, { recursive: true });

    // Save meta.json
    const meta: UserMeta = {
      currentSeq: cached.currentSeq,
      minSeq: cached.minSeq,
    };
    await fs.writeFile(
      path.join(userDir, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );

    // Save stores
    for (const [storeName, map] of cached.stores.entries()) {
      const filePath = this.getStoreFilePath(userDir, storeName);
      const obj: Record<string, StoredRecord> = Object.create(null);
      for (const [id, record] of map.entries()) {
        obj[id] = record;
      }
      await fs.writeFile(filePath, JSON.stringify(obj, null, 2), 'utf-8');
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
    validateStoreName(store, this.limits.allowedStores);
    validateRecordId(id);
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
    if (store !== undefined) {
      validateStoreName(store, this.limits.allowedStores);
    }
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
   * Applies an array of mutation change operations, enforces table/payload limits,
   * compacts changelog history, and persists updates to disk.
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

      const maxStores = this.limits.maxStoresPerUser ?? 50;
      const maxRecords = this.limits.maxRecordsPerStore ?? 10000;
      const maxRecordSize = this.limits.maxRecordSizeBytes ?? 512 * 1024;
      const maxChangelog = this.limits.maxChangelogEntries ?? 1000;

      for (const change of changes) {
        const storeName = validateStoreName(
          change.store,
          this.limits.allowedStores,
        );
        const recordId = validateRecordId(change.id);

        // Enforce max stores per user
        if (!user.stores.has(storeName) && user.stores.size >= maxStores) {
          throw new Error(
            `Store limit reached. Maximum ${maxStores} tables allowed per user.`,
          );
        }

        let storeMap = user.stores.get(storeName);
        if (!storeMap) {
          storeMap = new Map();
          user.stores.set(storeName, storeMap);
        }

        // Enforce max record payload size
        if (change.data !== undefined) {
          const payloadSize = calculateByteSize(change.data);
          if (payloadSize > maxRecordSize) {
            throw new Error(
              `Record size (${payloadSize} bytes) exceeds maximum allowed size of ${maxRecordSize} bytes.`,
            );
          }
        }

        const existing = storeMap.get(recordId);

        // Enforce max records per store on new insertions
        if (
          !existing &&
          !change.deleted &&
          change.op !== OperationType.Delete
        ) {
          if (storeMap.size >= maxRecords) {
            throw new Error(
              `Table "${storeName}" has reached the maximum capacity of ${maxRecords} records.`,
            );
          }
        }

        if (shouldOverwrite(change, existing)) {
          user.currentSeq += 1;
          const seq = user.currentSeq;

          const isDelete =
            change.op === OperationType.Delete || Boolean(change.deleted);
          const record: StoredRecord = {
            id: recordId,
            data: change.data,
            timestamp: change.timestamp,
            version: (existing?.version ?? 0) + 1,
            deleted: isDelete,
          };

          storeMap.set(recordId, record);

          const appliedChange: ChangeRecord & { seq: number } = {
            ...change,
            store: storeName,
            id: recordId,
            seq,
            version: record.version,
            deleted: isDelete,
          };

          user.changelog.push(appliedChange);
          applied.push(appliedChange);
        }
      }

      // Changelog Compaction: prune entries older than maxChangelogEntries
      if (user.changelog.length > maxChangelog) {
        const excess = user.changelog.length - maxChangelog;
        const pruned = user.changelog.splice(0, excess);
        if (pruned.length > 0) {
          const oldestRetained = user.changelog[0];
          user.minSeq = oldestRetained?.seq ?? user.currentSeq;
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
   * If `fromSeq < minSeq` (compacted window), `requiresSnapshot` is true.
   *
   * @param userId - Target user account identifier.
   * @param fromSeq - Starting sequence number (exclusive).
   * @returns Object with change records, current sequence number, and snapshot requirement flag.
   */
  async getChangesSince(
    userId: string,
    fromSeq: number,
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }> {
    return this.withUserLock(userId, async () => {
      const user = await this.loadUser(userId);

      // Check if client is requesting changes older than compacted changelog
      if (user.minSeq > 0 && fromSeq < user.minSeq) {
        return {
          changes: [],
          currentSeq: user.currentSeq,
          requiresSnapshot: true,
        };
      }

      const changes = user.changelog.filter((c) => (c.seq ?? 0) > fromSeq);
      return {
        changes,
        currentSeq: user.currentSeq,
        requiresSnapshot: false,
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
