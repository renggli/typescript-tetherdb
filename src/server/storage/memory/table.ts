import type {
  ChangeRecord,
  SnapshotRecord,
  StoredRecord,
  TableSettings,
} from '../../../shared/types.js';
import { validateRecordId } from '../../validate.js';
import {
  canRead,
  filterActiveRecords,
  TableBaseStorage,
} from '../base/index.js';
import type { UserStorage } from '../user.js';
import type { MemoryStorage } from './storage.js';

/**
 * In-memory implementation of `TableStorage`.
 */
export class TableMemoryStorage extends TableBaseStorage {
  private storage: MemoryStorage;

  constructor(
    name: string,
    storage: MemoryStorage,
    settings: TableSettings = {},
  ) {
    super(name, settings);
    this.storage = storage;
  }

  async getRecord(
    user: UserStorage | undefined,
    id: string,
  ): Promise<StoredRecord | undefined> {
    const safeId = validateRecordId(id);
    if (!canRead(this, user)) {
      return undefined;
    }
    const tableMap = this.storage.getTableRecordsMap(this.name, user?.id);
    const record = tableMap?.get(safeId);

    if (!record || record.deleted) {
      return undefined;
    }

    return record;
  }

  async getAllRecords(user?: UserStorage): Promise<SnapshotRecord[]> {
    if (!canRead(this, user)) {
      return [];
    }
    const tableMap = this.storage.getTableRecordsMap(this.name, user?.id);
    return tableMap ? filterActiveRecords(this.name, tableMap.values()) : [];
  }

  async applyChanges(
    user: UserStorage | undefined,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    const targeted = changes.map((c) => ({
      ...c,
      table: this.name,
    }));
    return this.storage.applyChanges(user, targeted);
  }

  async delete(): Promise<boolean> {
    return this.storage.deleteTable(this.name);
  }
}
