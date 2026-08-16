import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { shouldOverwrite } from '../../../shared/clock.js';
import {
  type ChangeRecord,
  OperationType,
  type StoredRecord,
} from '../../../shared/types.js';
import {
  calculateByteSize,
  getUserBucket,
  validateRecordId,
  validateTableName,
  validateUserId,
} from '../../validate.js';
import type { AppStorage } from '../app.js';
import type { TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';
import type { FileStorage } from './storage.js';
import { TableFileStorage } from './table.js';

export interface AppManifest {
  id: string;
  tables: string[];
  createdAt: number;
  version: number;
}

interface UserMeta {
  currentSeq: number;
  minSeq: number;
}

/**
 * Filesystem-backed application namespace storage implementation.
 */
export class AppFileStorage implements AppStorage {
  readonly id: string;
  readonly storage: FileStorage;

  constructor(id: string, storage: FileStorage) {
    this.id = id;
    this.storage = storage;
  }

  get appDir(): string {
    return path.join(this.storage.baseDir, this.id);
  }

  private get manifestFile(): string {
    return path.join(this.appDir, 'manifest.json');
  }

  getUserDir(userId: string): string {
    const safeUserId = validateUserId(userId);
    const bucket = getUserBucket(safeUserId);
    return path.join(this.appDir, 'users', bucket, safeUserId);
  }

  private getUserMetaFile(userId: string): string {
    return path.join(this.getUserDir(userId), 'meta.json');
  }

  private getUserSyncFile(userId: string): string {
    return path.join(this.getUserDir(userId), 'sync.jsonl');
  }

  getUserTablesDir(userId: string): string {
    return path.join(this.getUserDir(userId), 'tables');
  }

  getUserTableFile(userId: string, tableName: string): string {
    return path.join(this.getUserTablesDir(userId), `${tableName}.json`);
  }

  private async readManifest(): Promise<AppManifest> {
    try {
      const content = await fs.readFile(this.manifestFile, 'utf-8');
      return JSON.parse(content) as AppManifest;
    } catch {
      return {
        id: this.id,
        tables: [],
        createdAt: Date.now(),
        version: 1,
      };
    }
  }

  private async writeManifest(manifest: AppManifest): Promise<void> {
    await fs.mkdir(this.appDir, { recursive: true });
    await fs.writeFile(
      this.manifestFile,
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );
  }

  private async readUserMeta(userId: string): Promise<UserMeta> {
    try {
      const content = await fs.readFile(this.getUserMetaFile(userId), 'utf-8');
      return JSON.parse(content) as UserMeta;
    } catch {
      return { currentSeq: 0, minSeq: 0 };
    }
  }

  private async writeUserMeta(userId: string, meta: UserMeta): Promise<void> {
    await fs.mkdir(this.getUserDir(userId), { recursive: true });
    await fs.writeFile(
      this.getUserMetaFile(userId),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );
  }

  private async readUserSync(
    userId: string,
  ): Promise<Array<ChangeRecord & { seq: number }>> {
    try {
      const content = await fs.readFile(this.getUserSyncFile(userId), 'utf-8');
      const lines = content.split('\n');
      const changes: Array<ChangeRecord & { seq: number }> = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          changes.push(JSON.parse(trimmed) as ChangeRecord & { seq: number });
        }
      }
      return changes;
    } catch {
      return [];
    }
  }

  private async appendUserSync(
    userId: string,
    changes: Array<ChangeRecord & { seq: number }>,
  ): Promise<void> {
    if (changes.length === 0) return;
    await fs.mkdir(this.getUserDir(userId), { recursive: true });
    const content = `${changes.map((c) => JSON.stringify(c)).join('\n')}\n`;
    await fs.appendFile(this.getUserSyncFile(userId), content, 'utf-8');
  }

  private async rewriteUserSync(
    userId: string,
    changes: Array<ChangeRecord & { seq: number }>,
  ): Promise<void> {
    await fs.mkdir(this.getUserDir(userId), { recursive: true });
    const content =
      changes.length > 0
        ? `${changes.map((c) => JSON.stringify(c)).join('\n')}\n`
        : '';
    await fs.writeFile(this.getUserSyncFile(userId), content, 'utf-8');
  }

  private async readTableRecords(
    userId: string,
    tableName: string,
  ): Promise<Map<string, StoredRecord>> {
    try {
      const content = await fs.readFile(
        this.getUserTableFile(userId, tableName),
        'utf-8',
      );
      const list = JSON.parse(content) as StoredRecord[];
      const map = new Map<string, StoredRecord>();
      for (const rec of list) {
        map.set(rec.id, rec);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private async writeTableRecords(
    userId: string,
    tableName: string,
    records: Map<string, StoredRecord>,
  ): Promise<void> {
    await fs.mkdir(this.getUserTablesDir(userId), { recursive: true });
    await fs.writeFile(
      this.getUserTableFile(userId, tableName),
      JSON.stringify(Array.from(records.values()), null, 2),
      'utf-8',
    );
  }

  async createTable(name: string): Promise<TableStorage> {
    const safeName = validateTableName(name);
    const manifest = await this.readManifest();
    if (manifest.tables.includes(safeName)) {
      throw new Error(
        `Table "${safeName}" already exists in app "${this.id}".`,
      );
    }
    manifest.tables.push(safeName);
    manifest.tables.sort();
    await this.writeManifest(manifest);
    return new TableFileStorage(safeName, this);
  }

  async getTable(name: string): Promise<TableStorage | undefined> {
    const safeName = validateTableName(name);
    const manifest = await this.readManifest();
    if (manifest.tables.includes(safeName)) {
      return new TableFileStorage(safeName, this);
    }
    return undefined;
  }

  async getTables(): Promise<TableStorage[]> {
    const manifest = await this.readManifest();
    return manifest.tables.map((name) => new TableFileStorage(name, this));
  }

  async applyChanges(
    user: UserStorage,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    return this.storage.withUserLock(user.id, this.id, async () => {
      const manifest = await this.readManifest();
      const registeredTables = new Set(manifest.tables);
      const safeUserId = validateUserId(user.id);
      const applied: ChangeRecord[] = [];

      const maxRecords = this.storage.options.maxRecordsPerTable ?? 10000;
      const maxRecordSize =
        this.storage.options.maxRecordSizeBytes ?? 512 * 1024;
      const maxChangelog = this.storage.options.maxChangelogEntries ?? 1000;

      const meta = await this.readUserMeta(safeUserId);
      const syncChanges = await this.readUserSync(safeUserId);

      // Cache of modified tables
      const modifiedTables = new Map<string, Map<string, StoredRecord>>();

      for (const change of changes) {
        const tableName = validateTableName(change.table);
        const recordId = validateRecordId(change.id);

        if (!registeredTables.has(tableName)) {
          throw new Error(
            `Table "${tableName}" does not exist in app "${this.id}".`,
          );
        }

        let tableRecords = modifiedTables.get(tableName);
        if (!tableRecords) {
          tableRecords = await this.readTableRecords(safeUserId, tableName);
          modifiedTables.set(tableName, tableRecords);
        }

        if (
          change.op === OperationType.Put &&
          !tableRecords.has(recordId) &&
          tableRecords.size >= maxRecords
        ) {
          throw new Error(
            `Table "${tableName}" has reached the maximum capacity of ${maxRecords} records for user "${safeUserId}".`,
          );
        }

        const payloadBytes = calculateByteSize(change.data);
        if (payloadBytes > maxRecordSize) {
          throw new Error(
            `Record payload size (${payloadBytes} bytes) exceeds maximum allowed size of ${maxRecordSize} bytes for record "${recordId}" in table "${tableName}".`,
          );
        }

        const existing = tableRecords.get(recordId);
        const shouldApply = !existing || shouldOverwrite(change, existing);

        if (shouldApply) {
          meta.currentSeq++;
          const assignedSeq = meta.currentSeq;

          if (meta.minSeq === 0) {
            meta.minSeq = 1;
          }

          const isDeleted = change.op === OperationType.Delete;
          const nextVersion = (existing?.version ?? 0) + 1;

          const updatedRecord: StoredRecord = {
            id: recordId,
            version: nextVersion,
            timestamp: change.timestamp,
            clientId: change.clientId,
            deleted: isDeleted,
            data: isDeleted ? null : (change.data ?? null),
          };

          tableRecords.set(recordId, updatedRecord);

          const appliedChange: ChangeRecord & { seq: number } = {
            appId: this.id,
            seq: assignedSeq,
            table: tableName,
            id: recordId,
            op: change.op,
            version: nextVersion,
            timestamp: change.timestamp,
            clientId: change.clientId,
            deleted: isDeleted,
            data: isDeleted ? null : change.data,
          };

          applied.push(appliedChange);
          syncChanges.push(appliedChange);
        }
      }

      if (applied.length > 0) {
        for (const [tableName, records] of modifiedTables.entries()) {
          await this.writeTableRecords(safeUserId, tableName, records);
        }

        if (syncChanges.length > maxChangelog) {
          const pruneCount = syncChanges.length - maxChangelog;
          syncChanges.splice(0, pruneCount);
          if (syncChanges.length > 0) {
            meta.minSeq = syncChanges[0].seq;
          }
          await this.rewriteUserSync(safeUserId, syncChanges);
        } else {
          await this.appendUserSync(
            safeUserId,
            applied as Array<ChangeRecord & { seq: number }>,
          );
        }

        await this.writeUserMeta(safeUserId, meta);
      }

      return { applied, newSeq: meta.currentSeq };
    });
  }

  async getChangesSince(
    user: UserStorage,
    fromSeq: number,
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }> {
    const safeUserId = validateUserId(user.id);
    const meta = await this.readUserMeta(safeUserId);
    const currentSeq = meta.currentSeq;
    const minSeq = meta.minSeq;

    if (fromSeq < minSeq && minSeq > 0) {
      return { changes: [], currentSeq, requiresSnapshot: true };
    }

    const syncChanges = await this.readUserSync(safeUserId);
    const changes = syncChanges.filter((c) => c.seq > fromSeq);
    return { changes, currentSeq, requiresSnapshot: false };
  }

  async getCurrentSeq(user: UserStorage): Promise<number> {
    const safeUserId = validateUserId(user.id);
    const meta = await this.readUserMeta(safeUserId);
    return meta.currentSeq;
  }

  async delete(): Promise<boolean> {
    return this.storage.deleteApp(this.id);
  }

  async deleteTable(name: string): Promise<boolean> {
    const safeName = validateTableName(name);
    const manifest = await this.readManifest();
    const idx = manifest.tables.indexOf(safeName);
    if (idx === -1) return false;

    manifest.tables.splice(idx, 1);
    await this.writeManifest(manifest);

    // Delete table file from all user directories
    const usersRoot = path.join(this.appDir, 'users');
    try {
      const buckets = await fs.readdir(usersRoot, { withFileTypes: true });
      for (const bucket of buckets) {
        if (bucket.isDirectory()) {
          const bucketDir = path.join(usersRoot, bucket.name);
          const users = await fs.readdir(bucketDir, { withFileTypes: true });
          for (const user of users) {
            if (user.isDirectory()) {
              const tableFile = path.join(
                bucketDir,
                user.name,
                'tables',
                `${safeName}.json`,
              );
              try {
                await fs.rm(tableFile, { force: true });
              } catch {
                // Ignore
              }
            }
          }
        }
      }
    } catch {
      // Ignore if users directory doesn't exist
    }

    return true;
  }
}
