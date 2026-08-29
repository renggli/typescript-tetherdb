import {
  type ChangeRecord,
  OperationType,
  Permission,
  type SnapshotRecord,
  type StoredRecord,
  type TablePermissions,
  type TableRow,
  type TableSettings,
} from '../../../shared/types.js';
import { TetherServerError, TetherServerErrorCode } from '../../errors.js';
import type { ApplyChangesOptions, TableStorage } from '../table.js';
import type { UserStorage } from '../user.js';
import type { BaseStorage } from './storage.js';

/** Default table permission policy if not specified. */
export const DEFAULT_TABLE_PERMISSIONS: Required<TablePermissions> = {
  create: Permission.Authenticated,
  read: Permission.Owner,
  update: Permission.Owner,
  delete: Permission.Owner,
};

/**
 * Common abstract base class for TableStorage implementations.
 */
export abstract class TableBaseStorage<
  TStorage extends BaseStorage = BaseStorage,
> implements TableStorage
{
  readonly name: string;
  protected readonly storage: TStorage;
  settings: TableSettings = {
    permissions: { ...DEFAULT_TABLE_PERMISSIONS },
  };

  constructor(name: string, storage: TStorage, settings: TableSettings = {}) {
    this.name = name;
    this.storage = storage;
    this.mergeSettings(settings);
  }

  /**
   * Updates table settings dynamically.
   *
   * @param settings - Partial table settings to merge.
   * @returns Updated table settings.
   */
  async updateSettings(
    settings: Partial<TableSettings>,
  ): Promise<TableSettings> {
    return this.mergeSettings(settings);
  }

  abstract getRecord(
    user: UserStorage | undefined,
    id: string,
  ): Promise<StoredRecord | undefined>;

  abstract getAllRecords(user?: UserStorage): Promise<SnapshotRecord[]>;

  /**
   * Applies an array of mutation change operations targeting this table.
   *
   * @param user - Target user handle.
   * @param changes - Array of change records.
   * @param options - Application options.
   * @returns Applied changes and new sequence number.
   */
  async applyChanges(
    user: UserStorage | undefined,
    changes: ChangeRecord[],
    options?: ApplyChangesOptions,
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    const targeted = changes.map((c) => ({
      ...c,
      table: this.name,
    }));
    return this.storage.applyChanges(user, targeted, options);
  }

  /**
   * Inserts initial rows into this table if they do not already exist.
   * Resolves userName on each row to the corresponding user ID.
   *
   * @param rows - Array of table rows to insert.
   * @returns Number of new rows inserted.
   */
  async insertRows(rows: TableRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const existing = await this.getAllRecords();
    const existingIds = new Set(existing.map((r) => r.id));
    const toInsert = rows.filter((r) => !existingIds.has(r.id));
    if (toInsert.length === 0) return 0;

    const now = Date.now();
    for (const item of toInsert) {
      let authorUser: UserStorage | undefined;
      let userName: string | undefined;
      if (item.userName) {
        const user = await this.storage.getUserByUserName(item.userName);
        if (user) {
          authorUser = user;
          userName = user.userName;
        }
      }
      const change: ChangeRecord = {
        table: this.name,
        id: item.id,
        op: OperationType.Put,
        data: item.data,
        timestamp: now,
      };
      if (userName !== undefined) {
        change.userName = userName;
      }
      await this.applyChanges(authorUser, [change], {
        skipPermissionCheck: true,
      });
    }
    return toInsert.length;
  }

  /**
   * Deletes this table and its data from storage.
   *
   * @returns `true` if deleted successfully.
   */
  async delete(): Promise<boolean> {
    return this.storage.deleteTable(this.name);
  }

  // -- Private Helpers --------------------------------------------------------

  private mergeSettings(settings: Partial<TableSettings>): TableSettings {
    this.settings = {
      ...this.settings,
      ...settings,
      permissions: {
        ...this.settings.permissions,
        ...settings.permissions,
      },
    };
    return this.settings;
  }
}

/**
 * Determines if a table operates in user-private partition mode.
 *
 * @param table - Target table storage handle.
 * @returns `true` if table read permissions are restricted to owner.
 */
export function isPrivateTable(table: TableStorage): boolean {
  const readPerm = table.settings.permissions?.read ?? Permission.Owner;
  return readPerm === Permission.Owner;
}

/**
 * Filters non-deleted records and attaches table name for snapshot responses.
 *
 * @param tableName - Name of the table.
 * @param records - Iterable of stored records.
 * @returns Array of snapshot records.
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
 * Applies a change to an existing (or undefined) record and assigns the sequence number.
 *
 * @param change - Mutation change record to apply.
 * @param existing - Currently stored record or undefined.
 * @param seq - Assigned sequence number.
 * @param user - Target user handle.
 * @returns Updated record and applied change descriptor.
 */
export function applyChangeToRecord(
  change: ChangeRecord,
  existing: StoredRecord | undefined,
  seq: number,
  user?: UserStorage,
): {
  updatedRecord: StoredRecord & { userId?: string };
  appliedChange: ChangeRecord & { seq: number; userId?: string };
} {
  const isDeleted = change.op === OperationType.Delete;
  const nextVersion = (existing?.version ?? 0) + 1;
  const userId =
    (existing as { userId?: string } | undefined)?.userId ?? user?.userId;
  const userName = existing?.userName ?? user?.userName ?? change.userName;

  const updatedRecord: StoredRecord & { userId?: string } = {
    id: change.id,
    version: nextVersion,
    timestamp: change.timestamp,
    clientId: change.clientId,
    deleted: isDeleted,
    data: isDeleted ? null : (change.data ?? null),
    userId,
    userName,
  };

  const appliedChange: ChangeRecord & { seq: number; userId?: string } = {
    seq,
    table: change.table,
    id: change.id,
    op: change.op,
    version: nextVersion,
    timestamp: change.timestamp,
    clientId: change.clientId,
    data: isDeleted ? undefined : change.data,
    userId,
    userName,
  };

  return { updatedRecord, appliedChange };
}

/**
 * Checks if an actor permission rule allows the given user and record owner.
 *
 * @param permission - Permission level to check.
 * @param user - Authenticated user handle.
 * @param recordUserId - Owner user ID of the record.
 * @returns `true` if allowed.
 */
export function isPermissionAllowed(
  permission: Permission,
  user?: UserStorage,
  recordUserId?: string,
): boolean {
  switch (permission) {
    case Permission.Everybody:
      return true;
    case Permission.Authenticated:
      return user !== undefined;
    case Permission.Owner:
      return (
        user !== undefined &&
        (recordUserId === undefined || recordUserId === user.userId)
      );
    case Permission.Nobody:
      return false;
  }
}

/**
 * Verifies that a user has permission to mutate a record in a table.
 *
 * @param table - Target table handle.
 * @param user - Authenticated user handle.
 * @param change - Mutation change record.
 * @param existing - Existing record if present.
 * @throws TetherServerError if access is forbidden.
 */
export function assertCanMutate(
  table: TableStorage,
  user: UserStorage | undefined,
  change: ChangeRecord,
  existing?: StoredRecord,
): void {
  const perms = {
    ...DEFAULT_TABLE_PERMISSIONS,
    ...table.settings.permissions,
  };

  if (change.op === OperationType.Delete) {
    const perm = perms.delete;
    const recordUserId =
      (existing as { userId?: string } | undefined)?.userId ??
      (perm === Permission.Owner ? '' : undefined);
    if (!isPermissionAllowed(perm, user, recordUserId)) {
      throw new TetherServerError(
        TetherServerErrorCode.Forbidden,
        `User does not have delete access to record "${change.id}" in table "${table.name}"`,
      );
    }
    return;
  }

  // OperationType.Put
  if (!existing || existing.deleted) {
    // Creating a new record
    const perm = perms.create;
    if (!isPermissionAllowed(perm, user, undefined)) {
      throw new TetherServerError(
        TetherServerErrorCode.Forbidden,
        `User does not have create access to table "${table.name}"`,
      );
    }
  } else {
    // Updating an existing record
    const perm = perms.update;
    const recordUserId =
      (existing as { userId?: string } | undefined)?.userId ??
      (perm === Permission.Owner ? '' : undefined);
    if (!isPermissionAllowed(perm, user, recordUserId)) {
      throw new TetherServerError(
        TetherServerErrorCode.Forbidden,
        `User does not have update access to record "${change.id}" in table "${table.name}"`,
      );
    }
  }
}

/**
 * Checks if a user has read permission on a table.
 *
 * @param table - Target table handle.
 * @param user - Authenticated user handle.
 * @returns `true` if readable.
 */
export function canRead(table: TableStorage, user?: UserStorage): boolean {
  const readPerm = table.settings.permissions?.read ?? Permission.Owner;
  return isPermissionAllowed(readPerm, user, undefined);
}

/**
 * Checks if a specific record in a table can be read by the given user.
 *
 * @param table - Target table handle.
 * @param user - Authenticated user handle.
 * @param record - Stored record to check.
 * @returns `true` if readable.
 */
export function canReadRecord(
  table: TableStorage,
  user: UserStorage | undefined,
  record?: StoredRecord,
): boolean {
  if (!record || record.deleted) return false;
  const readPerm = table.settings.permissions?.read ?? Permission.Owner;
  const userId =
    (record as { userId?: string }).userId ??
    (readPerm === Permission.Owner ? '' : undefined);
  return isPermissionAllowed(readPerm, user, userId);
}
