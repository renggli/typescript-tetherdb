import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { shouldOverwrite } from '../../shared/clock.js';
import {
  calculateByteSize,
  validateAppId,
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
  /** Root directory on the filesystem where application and user data folders will be stored. */
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
 * Filesystem-backed storage adapter organizing data into sharded per-app, per-user subdirectories
 * (`<baseDir>/<appId>/<shard>/<userId>/stores/<storeName>.json` where `<shard> = userId.slice(0, 2)`).
 * Provides multi-application partitioning, path traversal defense, changelog compaction, and quota enforcement.
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

  private getUserKey(userId: string, appId?: string): string {
    const safeAppId = validateAppId(appId);
    const safeUserId = validateUserId(userId);
    return `${safeAppId}:${safeUserId}`;
  }

  private async withUserLock<T>(
    userId: string,
    appId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = this.getUserKey(userId, appId);
    const prevLock = this.userLocks.get(key) ?? Promise.resolve();
    let resolveLock: (() => void) | undefined;
    const newLock = new Promise<void>((resolve) => {
      resolveLock = resolve;
    });

    this.userLocks.set(key, newLock);

    try {
      await prevLock;
      return await fn();
    } finally {
      resolveLock?.();
      if (this.userLocks.get(key) === newLock) {
        this.userLocks.delete(key);
      }
    }
  }

  /**
   * Computes the sharded directory path for a user within an application with strict path confinement checks.
   *
   * @param userId - Validated user ID.
   * @param appId - Validated application ID.
   * @returns Absolute path to user directory `<baseDir>/<appId>/<shard>/<userId>`.
   */
  private getUserDir(userId: string, appId?: string): string {
    const safeAppId = validateAppId(appId);
    const safeUserId = validateUserId(userId);
    const shard = safeUserId.slice(0, 2).toLowerCase();
    const userDir = path.resolve(this.baseDir, safeAppId, shard, safeUserId);

    if (!userDir.startsWith(this.baseDir + path.sep)) {
      throw new Error(
        `Path traversal attempt detected for userId: "${userId}" in appId: "${appId}"`,
      );
    }
    return userDir;
  }

  /**
   * Computes the absolute file path for a store JSON file with strict path confinement.
   *
   * @param userDir - The user root directory.
   * @param storeName - Store name to validate and resolve.
   * @param userId - Optional user context for errors.
   * @returns Absolute path to store JSON file.
   */
  private getStoreFilePath(
    userDir: string,
    storeName: string,
    userId?: string,
  ): string {
    const safeStoreName = validateStoreName(
      storeName,
      this.limits.allowedStores,
      userId,
    );
    const storesDir = path.resolve(userDir, 'stores');
    const filePath = path.resolve(storesDir, `${safeStoreName}.json`);

    if (!filePath.startsWith(storesDir + path.sep)) {
      const userSuffix = userId ? ` (user: "${userId}")` : '';
      throw new Error(
        `Path traversal attempt detected for table: "${storeName}"${userSuffix}`,
      );
    }
    return filePath;
  }

  private async loadUser(
    userId: string,
    appId?: string,
  ): Promise<UserCacheEntry> {
    const key = this.getUserKey(userId, appId);
    let cached = this.userCache.get(key);
    if (cached?.loaded) return cached;

    cached = {
      currentSeq: 0,
      minSeq: 0,
      stores: new Map(),
      changelog: [],
      loaded: true,
    };

    const userDir = this.getUserDir(userId, appId);
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
            validateStoreName(storeName, this.limits.allowedStores, userId);
          } catch {
            continue; // Skip invalid or non-allowlisted store files
          }
          const content = await fs.readFile(
            path.join(storesDir, file),
            'utf-8',
          );
          const recordsObj: Record<string, StoredRecord> = JSON.parse(content);
          const map = new Map<string, StoredRecord>();
          for (const [recKey, val] of Object.entries(recordsObj)) {
            if (recKey !== '__proto__' && recKey !== 'prototype') {
              map.set(recKey, val);
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

    this.userCache.set(key, cached);
    return cached;
  }

  private async persistUser(userId: string, appId?: string): Promise<void> {
    const key = this.getUserKey(userId, appId);
    const cached = this.userCache.get(key);
    if (!cached) return;

    const userDir = this.getUserDir(userId, appId);
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
      const filePath = this.getStoreFilePath(userDir, storeName, userId);
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
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Stored record or `undefined` if not found.
   */
  async getRecord(
    userId: string,
    store: string,
    id: string,
    appId?: string,
  ): Promise<StoredRecord | undefined> {
    validateStoreName(store, this.limits.allowedStores, userId);
    validateRecordId(id, store, userId);
    return this.withUserLock(userId, appId, async () => {
      const user = await this.loadUser(userId, appId);
      const storeMap = user.stores.get(store);
      return storeMap?.get(id);
    });
  }

  /**
   * Retrieves all non-deleted records for a user across all tables (or a specific table).
   *
   * @param userId - Target user account identifier.
   * @param store - Optional table name to filter.
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Array of snapshot items.
   */
  async getAllRecords(
    userId: string,
    store?: string,
    appId?: string,
  ): Promise<RecordSnapshotItem[]> {
    if (store !== undefined) {
      validateStoreName(store, this.limits.allowedStores, userId);
    }
    const safeAppId = validateAppId(appId);
    return this.withUserLock(userId, appId, async () => {
      const user = await this.loadUser(userId, appId);
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
              appId: safeAppId,
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
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Object with applied changes and new sequence number.
   */
  async applyChanges(
    userId: string,
    changes: ChangeRecord[],
    appId?: string,
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    const safeAppId = validateAppId(appId);
    return this.withUserLock(userId, appId, async () => {
      const user = await this.loadUser(userId, appId);
      const applied: ChangeRecord[] = [];

      const maxStores = this.limits.maxStoresPerUser ?? 50;
      const maxRecords = this.limits.maxRecordsPerStore ?? 10000;
      const maxRecordSize = this.limits.maxRecordSizeBytes ?? 512 * 1024;
      const maxChangelog = this.limits.maxChangelogEntries ?? 1000;

      for (const change of changes) {
        const storeName = validateStoreName(
          change.store,
          this.limits.allowedStores,
          userId,
        );
        const recordId = validateRecordId(change.id, change.store, userId);

        // Enforce max stores per user in this app
        if (!user.stores.has(storeName) && user.stores.size >= maxStores) {
          throw new Error(
            `Store limit reached. Maximum ${maxStores} tables allowed for user "${userId}" in app "${safeAppId}".`,
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
              `Record size (${payloadSize} bytes) for record "${recordId}" in table "${storeName}" exceeds maximum allowed size of ${maxRecordSize} bytes for user "${userId}" in app "${safeAppId}".`,
            );
          }
        }

        const existing = storeMap.get(recordId);
        const isInsertingActive =
          (!existing || existing.deleted) &&
          !change.deleted &&
          change.op !== OperationType.Delete;

        // Enforce max records per store on active record insertions
        if (isInsertingActive) {
          let activeCount = 0;
          for (const r of storeMap.values()) {
            if (!r.deleted) activeCount++;
          }
          if (activeCount >= maxRecords) {
            throw new Error(
              `Table "${storeName}" has reached the maximum capacity of ${maxRecords} records for user "${userId}" in app "${safeAppId}".`,
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
            appId: safeAppId,
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
        await this.persistUser(userId, appId);
      }

      return { applied, newSeq: user.currentSeq };
    });
  }

  /**
   * Retrieves all changes applied since the given sequence number for a user in an application.
   * If `fromSeq < minSeq` (compacted window), `requiresSnapshot` is true.
   *
   * @param userId - Target user account identifier.
   * @param fromSeq - Starting sequence number (exclusive).
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Object with change records, current sequence number, and snapshot requirement flag.
   */
  async getChangesSince(
    userId: string,
    fromSeq: number,
    appId?: string,
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }> {
    return this.withUserLock(userId, appId, async () => {
      const user = await this.loadUser(userId, appId);

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
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Current integer sequence number.
   */
  async getCurrentSeq(userId: string, appId?: string): Promise<number> {
    return this.withUserLock(userId, appId, async () => {
      const user = await this.loadUser(userId, appId);
      return user.currentSeq;
    });
  }

  /**
   * Lists all application namespaces on the server, or created for a specific user.
   *
   * @param userId - Optional user ID filter.
   * @returns Array of unique application IDs.
   */
  async listApps(userId?: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.baseDir, { withFileTypes: true });
      const appDirs: string[] = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        if (
          name === 'users.json' ||
          name === 'secret.key' ||
          name.startsWith('.')
        ) {
          continue;
        }
        try {
          validateAppId(name);
        } catch {
          continue;
        }

        if (userId) {
          const userDir = this.getUserDir(userId, name);
          try {
            await fs.access(userDir);
            appDirs.push(name);
          } catch {
            // User does not have data in this app
          }
        } else {
          appDirs.push(name);
        }
      }

      return appDirs.sort();
    } catch {
      return [];
    }
  }

  /**
   * Lists all table/store names created within an application for a user.
   *
   * @param userId - Target user account identifier.
   * @param appId - Optional application namespace (defaults to 'default').
   * @returns Array of table names.
   */
  async listStores(userId: string, appId?: string): Promise<string[]> {
    return this.withUserLock(userId, appId, async () => {
      const user = await this.loadUser(userId, appId);
      return Array.from(user.stores.keys()).sort();
    });
  }

  /**
   * Clears the in-memory cache.
   */
  async close(): Promise<void> {
    this.userCache.clear();
  }
}
