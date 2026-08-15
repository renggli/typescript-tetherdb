import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  ChangeRecord,
  RecordSnapshotItem,
  StoredRecord,
} from '../../../shared/types.js';
import { validateRecordId, validateUserId } from '../../validate.js';
import type { TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';
import type { AppFileStorage } from './app.js';
import type { FileStorage } from './storage.js';

/**
 * Filesystem-backed implementation of `TableStorage`.
 */
export class TableFileStorage implements TableStorage {
  readonly name: string;
  readonly app: AppFileStorage;
  private storage: FileStorage;

  constructor(name: string, app: AppFileStorage, storage: FileStorage) {
    this.name = name;
    this.app = app;
    this.storage = storage;
  }

  private getUserTableFile(userId: string): string {
    const safeUserId = validateUserId(userId);
    return path.join(
      this.storage.baseDir,
      this.app.id,
      safeUserId,
      `${this.name}.json`,
    );
  }

  private async readTableRecords(
    userId: string,
  ): Promise<Map<string, StoredRecord>> {
    try {
      const file = this.getUserTableFile(userId);
      const content = await fs.readFile(file, 'utf-8');
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

  async getRecord(
    user: UserStorage,
    id: string,
  ): Promise<StoredRecord | undefined> {
    const safeUserId = validateUserId(user.id);
    const safeId = validateRecordId(id);
    const map = await this.readTableRecords(safeUserId);
    const record = map.get(safeId);
    if (!record || record.deleted) {
      return undefined;
    }
    return record;
  }

  async getAllRecords(user: UserStorage): Promise<RecordSnapshotItem[]> {
    const safeUserId = validateUserId(user.id);
    const map = await this.readTableRecords(safeUserId);
    const items: RecordSnapshotItem[] = [];

    for (const rec of map.values()) {
      if (!rec.deleted) {
        items.push({
          appId: this.app.id,
          table: this.name,
          id: rec.id,
          data: rec.data,
          version: rec.version,
          timestamp: rec.timestamp,
          clientId: rec.clientId,
        });
      }
    }

    return items;
  }

  async applyChanges(
    user: UserStorage,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    const targetedChanges = changes.map((c) => ({
      ...c,
      table: this.name,
      appId: this.app.id,
    }));
    return this.app.applyChanges(user, targetedChanges);
  }

  async delete(): Promise<boolean> {
    return this.app.deleteTable(this.name);
  }
}
