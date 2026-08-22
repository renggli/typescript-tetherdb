import type { SnapshotRecord, StoredRecord } from '../../../shared/types.js';
import { validateRecordId, validateUserId } from '../../validate.js';
import { filterActiveRecords, TableBaseStorage } from '../base/index.js';
import type { UserStorage } from '../user.js';
import type { AppFileStorage } from './app.js';

/**
 * Filesystem-backed implementation of `TableStorage`.
 */
export class TableFileStorage extends TableBaseStorage {
  declare readonly app: AppFileStorage;

  async getRecord(
    user: UserStorage,
    id: string,
  ): Promise<StoredRecord | undefined> {
    const safeUserId = validateUserId(user.id);
    const safeId = validateRecordId(id);
    const map = await this.app.readTableRecords(safeUserId, this.name);
    const record = map.get(safeId);
    if (!record || record.deleted) {
      return undefined;
    }
    return record;
  }

  async getAllRecords(user: UserStorage): Promise<SnapshotRecord[]> {
    const safeUserId = validateUserId(user.id);
    const map = await this.app.readTableRecords(safeUserId, this.name);
    return filterActiveRecords(this.name, map.values());
  }

  async delete(): Promise<boolean> {
    return this.app.deleteTable(this.name);
  }
}
