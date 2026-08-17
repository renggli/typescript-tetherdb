import * as fs from 'node:fs/promises';
import type {
  ChangeRecord,
  SnapshotRecord,
  StoredRecord,
} from '../../../shared/types.js';
import { validateRecordId, validateUserId } from '../../validate.js';
import type { TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';
import type { AppFileStorage } from './app.js';

/**
 * Filesystem-backed implementation of `TableStorage`.
 */
export class TableFileStorage implements TableStorage {
  readonly name: string;
  readonly app: AppFileStorage;

  constructor(name: string, app: AppFileStorage) {
    this.name = name;
    this.app = app;
  }

  private getUserTableFile(userId: string): string {
    return this.app.getUserTableFile(userId, this.name);
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

  async getAllRecords(user: UserStorage): Promise<SnapshotRecord[]> {
    const safeUserId = validateUserId(user.id);
    const map = await this.readTableRecords(safeUserId);
    const items: SnapshotRecord[] = [];

    for (const rec of map.values()) {
      if (!rec.deleted) {
        items.push({
          ...rec,
          table: this.name,
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
