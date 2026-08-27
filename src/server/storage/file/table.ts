import type {
  ChangeRecord,
  SnapshotRecord,
  StoredRecord,
  TableSettings,
} from '../../../shared/types.js';
import { validateRecordId, validateUserId } from '../../validate.js';
import {
  canRead,
  filterActiveRecords,
  isPrivateTable,
  TableBaseStorage,
} from '../base/index.js';
import type { UserStorage } from '../user.js';
import type { FileStorage } from './storage.js';

/**
 * Filesystem-backed implementation of `TableStorage`.
 */
export class TableFileStorage extends TableBaseStorage {
  private storage: FileStorage;

  constructor(
    name: string,
    storage: FileStorage,
    settings: TableSettings = {},
  ) {
    super(name, settings);
    this.storage = storage;
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
    const isPrivate = isPrivateTable(this);
    const effectiveUserId = isPrivate
      ? user
        ? validateUserId(user.id)
        : undefined
      : '__shared__';
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
    const isPrivate = isPrivateTable(this);
    const effectiveUserId = isPrivate
      ? user
        ? validateUserId(user.id)
        : undefined
      : '__shared__';
    if (!effectiveUserId) return [];

    const map = await this.storage.readTableRecords(effectiveUserId, this.name);
    return filterActiveRecords(this.name, map.values());
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
