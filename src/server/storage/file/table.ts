import type {
  SnapshotRecord,
  StoredRecord,
  TableSettings,
} from '../../../shared/types.js';
import { validateRecordId } from '../../shared/validate.js';
import {
  canRead,
  filterActiveRecords,
  TableBaseStorage,
} from '../base/index.js';
import type { UserStorage } from '../user.js';
import type { FileStorage } from './storage.js';

/**
 * Filesystem-backed implementation of `TableStorage`.
 */
export class TableFileStorage extends TableBaseStorage<FileStorage> {
  constructor(
    name: string,
    storage: FileStorage,
    settings: Partial<TableSettings> = {},
  ) {
    super(name, storage, settings);
  }

  override async updateSettings(
    settings: Partial<TableSettings>,
  ): Promise<TableSettings> {
    const updated = await super.updateSettings(settings);
    await this.storage.updateTableSettingsInFile(this.name, updated);
    return updated;
  }

  async getRecord(
    user: UserStorage | undefined,
    id: string,
  ): Promise<StoredRecord | undefined> {
    if (!canRead(this, user)) {
      return undefined;
    }
    const effectiveUserId = this.resolveEffectiveUserId(user);
    if (!effectiveUserId) return undefined;

    const safeId = validateRecordId(id);
    const map = await this.storage.readTableRecords(effectiveUserId, this.name);
    const record = map.get(safeId);
    if (!record || record.deleted) {
      return undefined;
    }
    return record;
  }

  async getAllRecords(user?: UserStorage): Promise<SnapshotRecord[]> {
    if (!canRead(this, user)) {
      return [];
    }
    const effectiveUserId = this.resolveEffectiveUserId(user);
    if (!effectiveUserId) return [];

    const map = await this.storage.readTableRecords(effectiveUserId, this.name);
    return filterActiveRecords(this.name, map.values());
  }
}
