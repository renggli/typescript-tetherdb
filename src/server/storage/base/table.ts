import {
  type ChangeRecord,
  OperationType,
  Permission,
  type SnapshotRecord,
  type StoredRecord,
  type TablePermissions,
  type TableSettings,
} from '../../../shared/types.js';
import { TetherServerError, TetherServerErrorCode } from '../../errors.js';
import type { TableStorage } from '../table.js';
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

  /** Updates table settings dynamically. */
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
 */
export function isPrivateTable(table: TableStorage): boolean {
  const readPerm = table.settings.permissions?.read ?? Permission.Owner;
  return readPerm === Permission.Owner;
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
 * Applies a change to an existing (or undefined) record and assigns the sequence number.
 */
export function applyChangeToRecord(
  change: ChangeRecord,
  existing: StoredRecord | undefined,
  seq: number,
  user?: UserStorage,
): {
  updatedRecord: StoredRecord;
  appliedChange: ChangeRecord & { seq: number };
} {
  const isDeleted = change.op === OperationType.Delete;
  const nextVersion = (existing?.version ?? 0) + 1;
  const ownerId = existing?.ownerId ?? user?.id;

  const updatedRecord: StoredRecord = {
    id: change.id,
    version: nextVersion,
    timestamp: change.timestamp,
    clientId: change.clientId,
    deleted: isDeleted,
    data: isDeleted ? null : (change.data ?? null),
    ownerId,
  };

  const appliedChange: ChangeRecord & { seq: number } = {
    seq,
    table: change.table,
    id: change.id,
    op: change.op,
    version: nextVersion,
    timestamp: change.timestamp,
    clientId: change.clientId,
    data: isDeleted ? undefined : change.data,
    ownerId,
  };

  return { updatedRecord, appliedChange };
}

/**
 * Checks if an actor permission rule allows the given user and record owner.
 */
export function isPermissionAllowed(
  permission: Permission,
  user?: UserStorage,
  recordOwnerId?: string,
): boolean {
  switch (permission) {
    case Permission.Everybody:
      return true;
    case Permission.Authenticated:
      return user !== undefined;
    case Permission.Owner:
      return (
        user !== undefined &&
        (recordOwnerId === undefined || recordOwnerId === user.id)
      );
    case Permission.Nobody:
      return false;
  }
}

/**
 * Verifies that a user has permission to mutate a record in a table.
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
    const ownerId =
      existing?.ownerId ?? (perm === Permission.Owner ? '' : undefined);
    if (!isPermissionAllowed(perm, user, ownerId)) {
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
    const ownerId =
      existing.ownerId ?? (perm === Permission.Owner ? '' : undefined);
    if (!isPermissionAllowed(perm, user, ownerId)) {
      throw new TetherServerError(
        TetherServerErrorCode.Forbidden,
        `User does not have update access to record "${change.id}" in table "${table.name}"`,
      );
    }
  }
}

/**
 * Checks if a user has read permission on a table.
 */
export function canRead(table: TableStorage, user?: UserStorage): boolean {
  const readPerm = table.settings.permissions?.read ?? Permission.Owner;
  return isPermissionAllowed(readPerm, user, undefined);
}

/**
 * Checks if a specific record in a table can be read by the given user.
 */
export function canReadRecord(
  table: TableStorage,
  user: UserStorage | undefined,
  record?: StoredRecord,
): boolean {
  if (!record || record.deleted) return false;
  const readPerm = table.settings.permissions?.read ?? Permission.Owner;
  const ownerId =
    record.ownerId ?? (readPerm === Permission.Owner ? '' : undefined);
  return isPermissionAllowed(readPerm, user, ownerId);
}
