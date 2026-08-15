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
  validateRecordId,
  validateTableName,
  validateUserId,
} from '../../validate.js';
import type { AppStorage } from '../app.js';
import type { TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';
import type { FileStorage } from './storage.js';
import { TableFileStorage } from './table.js';

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

  private get appDir(): string {
    return path.join(this.storage.baseDir, this.id);
  }

  private get tablesFile(): string {
    return path.join(this.appDir, 'tables.json');
  }

  private getUserDir(userId: string): string {
    const safeUserId = validateUserId(userId);
    return path.join(this.appDir, safeUserId);
  }

  private getUserMetaFile(userId: string): string {
    return path.join(this.getUserDir(userId), 'meta.json');
  }

  private getUserChangelogFile(userId: string): string {
    return path.join(this.getUserDir(userId), 'changelog.json');
  }

  private getUserTableFile(userId: string, tableName: string): string {
    return path.join(this.getUserDir(userId), `${tableName}.json`);
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

  private async readUserChangelog(
    userId: string,
  ): Promise<Array<ChangeRecord & { seq: number }>> {
    try {
      const content = await fs.readFile(
        this.getUserChangelogFile(userId),
        'utf-8',
      );
      return JSON.parse(content) as Array<ChangeRecord & { seq: number }>;
    } catch {
      return [];
    }
  }

  private async writeUserChangelog(
    userId: string,
    changelog: Array<ChangeRecord & { seq: number }>,
  ): Promise<void> {
    await fs.mkdir(this.getUserDir(userId), { recursive: true });
    await fs.writeFile(
      this.getUserChangelogFile(userId),
      JSON.stringify(changelog, null, 2),
      'utf-8',
    );
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
    await fs.mkdir(this.getUserDir(userId), { recursive: true });
    await fs.writeFile(
      this.getUserTableFile(userId, tableName),
      JSON.stringify(Array.from(records.values()), null, 2),
      'utf-8',
    );
  }

  private async readTablesFile(): Promise<string[]> {
    try {
      const content = await fs.readFile(this.tablesFile, 'utf-8');
      return JSON.parse(content) as string[];
    } catch {
      return [];
    }
  }

  private async writeTablesFile(tables: string[]): Promise<void> {
    await fs.mkdir(this.appDir, { recursive: true });
    await fs.writeFile(
      this.tablesFile,
      JSON.stringify(Array.from(new Set(tables)).sort(), null, 2),
      'utf-8',
    );
  }

  async createTable(name: string): Promise<TableStorage> {
    const safeName = validateTableName(name);
    const tables = await this.readTablesFile();
    if (!tables.includes(safeName)) {
      tables.push(safeName);
      await this.writeTablesFile(tables);
    }
    return new TableFileStorage(safeName, this, this.storage);
  }

  async getTable(name: string): Promise<TableStorage | undefined> {
    const safeName = validateTableName(name);
    const tables = await this.readTablesFile();
    if (tables.includes(safeName)) {
      return new TableFileStorage(safeName, this, this.storage);
    }
    return undefined;
  }

  async getTables(): Promise<TableStorage[]> {
    const tables = await this.readTablesFile();
    return tables.map((name) => new TableFileStorage(name, this, this.storage));
  }

  async applyChanges(
    user: UserStorage,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    return this.storage.withUserLock(user.id, this.id, async () => {
      const registeredTables = new Set(await this.readTablesFile());
      const safeUserId = validateUserId(user.id);
      const applied: ChangeRecord[] = [];

      const maxRecords = this.storage.options.maxRecordsPerTable ?? 10000;
      const maxRecordSize =
        this.storage.options.maxRecordSizeBytes ?? 512 * 1024;
      const maxChangelog = this.storage.options.maxChangelogEntries ?? 1000;

      const meta = await this.readUserMeta(safeUserId);
      const changelog = await this.readUserChangelog(safeUserId);

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
          changelog.push(appliedChange);

          if (changelog.length > maxChangelog) {
            const pruneCount = changelog.length - maxChangelog;
            changelog.splice(0, pruneCount);
            if (changelog.length > 0) {
              meta.minSeq = changelog[0].seq;
            }
          }
        }
      }

      if (applied.length > 0) {
        for (const [tableName, records] of modifiedTables.entries()) {
          await this.writeTableRecords(safeUserId, tableName, records);
        }
        await this.writeUserChangelog(safeUserId, changelog);
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

    const changelog = await this.readUserChangelog(safeUserId);
    const changes = changelog.filter((c) => c.seq > fromSeq);
    return { changes, currentSeq, requiresSnapshot: false };
  }

  async getCurrentSeq(user: UserStorage): Promise<number> {
    const safeUserId = validateUserId(user.id);
    const meta = await this.readUserMeta(safeUserId);
    return meta.currentSeq;
  }

  async delete(): Promise<boolean> {
    try {
      await fs.rm(this.appDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  async deleteTable(name: string): Promise<boolean> {
    const safeName = validateTableName(name);
    const tables = await this.readTablesFile();
    const idx = tables.indexOf(safeName);
    if (idx === -1) return false;

    tables.splice(idx, 1);
    await this.writeTablesFile(tables);

    // Delete table file from all user directories
    try {
      const entries = await fs.readdir(this.appDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const tableFile = path.join(
            this.appDir,
            entry.name,
            `${safeName}.json`,
          );
          try {
            await fs.rm(tableFile, { force: true });
          } catch {
            // Ignore
          }
        }
      }
    } catch {
      // Ignore
    }

    return true;
  }
}
