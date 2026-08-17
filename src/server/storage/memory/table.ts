import type {
  ChangeRecord,
  SnapshotRecord,
  StoredRecord,
} from '../../../shared/types.js';
import { validateRecordId } from '../../validate.js';
import type { TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';
import type { AppMemoryStorage } from './app.js';
import type { MemoryStorage } from './storage.js';

/**
 * In-memory implementation of `TableStorage`.
 */
export class TableMemoryStorage implements TableStorage {
  readonly name: string;
  readonly app: AppMemoryStorage;
  private storage: MemoryStorage;

  constructor(name: string, app: AppMemoryStorage, storage: MemoryStorage) {
    this.name = name;
    this.app = app;
    this.storage = storage;
  }

  async getRecord(
    user: UserStorage,
    id: string,
  ): Promise<StoredRecord | undefined> {
    const safeId = validateRecordId(id);
    const userState = this.storage.getUserState(user.id, this.app.id);
    const tableMap = userState.tables.get(this.name);
    const record = tableMap?.get(safeId);

    if (!record || record.deleted) {
      return undefined;
    }

    return record;
  }

  async getAllRecords(user: UserStorage): Promise<SnapshotRecord[]> {
    const userState = this.storage.getUserState(user.id, this.app.id);
    const tableMap = userState.tables.get(this.name);
    const items: SnapshotRecord[] = [];

    if (tableMap) {
      for (const rec of tableMap.values()) {
        if (!rec.deleted) {
          items.push({
            ...rec,
            table: this.name,
          });
        }
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
