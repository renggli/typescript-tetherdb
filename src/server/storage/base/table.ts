import type {
  ChangeRecord,
  SnapshotRecord,
  StoredRecord,
} from '../../../shared/types.js';
import type { AppStorage } from '../app.js';
import type { TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';

/**
 * Common abstract base class for TableStorage implementations.
 */
export abstract class TableBaseStorage implements TableStorage {
  readonly name: string;
  readonly app: AppStorage;

  constructor(name: string, app: AppStorage) {
    this.name = name;
    this.app = app;
  }

  /** Retrieves a single record for a user. */
  abstract getRecord(
    user: UserStorage,
    id: string,
  ): Promise<StoredRecord | undefined>;

  /** Retrieves all active records in this table for a user. */
  abstract getAllRecords(user: UserStorage): Promise<SnapshotRecord[]>;

  /** Deletes this table and its data. */
  abstract delete(): Promise<boolean>;

  /** Applies batch mutation changes to this table. */
  async applyChanges(
    user: UserStorage,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    return this.app.applyChanges(
      user,
      targetChangesForTable(this.name, this.app.id, changes),
    );
  }
}

/**
 * Filters non-deleted records and attaches table name for snapshot responses.
 */
export function filterActiveRecords(
  tableName: string,
  records: Iterable<StoredRecord>,
): SnapshotRecord[] {
  const items: SnapshotRecord[] = [];
  for (const rec of records) {
    if (!rec.deleted) {
      items.push({
        ...rec,
        table: tableName,
      });
    }
  }
  return items;
}

/**
 * Targets generic changes with table name and app ID.
 */
export function targetChangesForTable(
  tableName: string,
  appId: string,
  changes: ChangeRecord[],
): ChangeRecord[] {
  return changes.map((c) => ({
    ...c,
    table: tableName,
    appId,
  }));
}
