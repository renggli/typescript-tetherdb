import type { SnapshotRecord, StoredRecord } from '../../../shared/types.js';
import { validateRecordId } from '../../validate.js';
import { filterActiveRecords, TableBaseStorage } from '../base/index.js';
import type { UserStorage } from '../user.js';
import type { AppMemoryStorage } from './app.js';
import type { MemoryStorage } from './storage.js';

/**
 * In-memory implementation of `TableStorage`.
 */
export class TableMemoryStorage extends TableBaseStorage {
  declare readonly app: AppMemoryStorage;
  private storage: MemoryStorage;

  constructor(name: string, app: AppMemoryStorage, storage: MemoryStorage) {
    super(name, app);
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
    return tableMap ? filterActiveRecords(this.name, tableMap.values()) : [];
  }

  async delete(): Promise<boolean> {
    return this.app.deleteTable(this.name);
  }
}
