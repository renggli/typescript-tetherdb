import {
  type ChangeRecord,
  DEFAULT_TABLE_PERMISSIONS,
  OperationType,
  Permission,
  type SnapshotRecord,
  type StoredRecord,
  type TableRow,
  type TableSettings,
} from '../../shared/types.js';
import { TetherServerError, TetherServerErrorCode } from '../errors.js';
import {
  isPermissionAllowed,
  sanitizeStoredRecord,
} from '../security/filter.js';
import { UserResolver } from '../security/resolver.js';
import type { InternalStoredRecord } from '../security/types.js';
import type { Storage } from './storage.js';
import { User } from './user.js';

/**
 * Concrete Table domain object providing access control and record operations.
 */
export class Table {
  readonly name: string;
  readonly storage: Storage;
  settings: TableSettings;

  /**
   * Initializes a new Table instance.
   *
   * @param name - Table identifier.
   * @param storage - Underlying storage backend.
   * @param settings - Optional initial table settings.
   */
  constructor(
    name: string,
    storage: Storage,
    settings: Partial<TableSettings> = {},
  ) {
    this.name = name;
    this.storage = storage;
    this.settings = {
      ...settings,
      permissions: {
        ...DEFAULT_TABLE_PERMISSIONS,
        ...settings.permissions,
      },
    };
  }

  /**
   * True if this table is user-partitioned (private to individual user accounts).
   */
  get isPrivate(): boolean {
    return this.settings.permissions.read === Permission.Owner;
  }

  /**
   * Updates settings for this table.
   *
   * @param settings - Partial or complete table settings.
   * @returns Updated TableSettings.
   */
  async updateSettings(
    settings: Partial<TableSettings>,
  ): Promise<TableSettings> {
    const updated: TableSettings = {
      ...this.settings,
      ...settings,
      permissions: {
        ...this.settings.permissions,
        ...settings.permissions,
      },
    };
    if (settings.maxRecords === 0) {
      delete updated.maxRecords;
    }
    if (settings.maxRecordSizeBytes === 0) {
      delete updated.maxRecordSizeBytes;
    }
    if (settings.maxHistoryEntries === 0) {
      delete updated.maxHistoryEntries;
    }
    this.settings = updated;
    await this.storage.updateTableSettings?.(this.name, updated);
    return this.settings;
  }

  /**
   * Checks if user has permission to create records in this table.
   *
   * @param user - Target user handle.
   */
  canCreate(user: User): boolean {
    return this.canAccess(this.settings.permissions.create, user);
  }

  /**
   * Checks if user has permission to read a record (or the entire table).
   *
   * @param user - Target user handle.
   * @param record - Optional specific record to check.
   */
  canRead(user: User, record?: InternalStoredRecord): boolean {
    return record
      ? isPermissionAllowed(this.settings.permissions.read, user, record.userId)
      : this.canAccess(this.settings.permissions.read, user);
  }

  /**
   * Checks if user has permission to update an existing record.
   *
   * @param user - Target user handle.
   * @param existing - Existing record to update.
   */
  canUpdate(user: User, existing?: InternalStoredRecord): boolean {
    return existing
      ? isPermissionAllowed(
          this.settings.permissions.update,
          user,
          existing.userId,
        )
      : this.canAccess(this.settings.permissions.update, user);
  }

  /**
   * Checks if user has permission to delete a record.
   *
   * @param user - Target user handle.
   * @param existing - Existing record to delete.
   */
  canDelete(user: User, existing?: InternalStoredRecord): boolean {
    return existing
      ? isPermissionAllowed(
          this.settings.permissions.delete,
          user,
          existing.userId,
        )
      : this.canAccess(this.settings.permissions.delete, user);
  }

  /**
   * Asserts that a user has permission to apply the specified change to an existing (or new) record.
   *
   * @param user - Target user handle.
   * @param change - Change record being applied.
   * @param existing - Existing stored record, if any.
   * @throws TetherServerError with Forbidden code if unauthorized.
   */
  assertCanApplyChange(
    user: User,
    change: { op: OperationType; id: string; table?: string },
    existing?: InternalStoredRecord,
  ): void {
    if (user.isAdmin) return;
    const tableName = change.table ?? this.name;
    if (change.op === OperationType.Delete) {
      if (!this.canDelete(user, existing)) {
        throw new TetherServerError(
          TetherServerErrorCode.Forbidden,
          `User does not have delete access to record "${change.id}" in table "${tableName}"`,
        );
      }
    } else if (!existing || existing.deleted) {
      if (!this.canCreate(user)) {
        throw new TetherServerError(
          TetherServerErrorCode.Forbidden,
          `User does not have create access to table "${tableName}"`,
        );
      }
    } else if (!this.canUpdate(user, existing)) {
      throw new TetherServerError(
        TetherServerErrorCode.Forbidden,
        `User does not have update access to record "${change.id}" in table "${tableName}"`,
      );
    }
  }

  /**
   * Retrieves a single stored record by ID for a user.
   *
   * @param user - Target user handle.
   * @param id - Record identifier.
   * @returns Stored record or `undefined`.
   */
  async getRecord(user: User, id: string): Promise<StoredRecord | undefined> {
    if (!this.canRead(user)) return undefined;
    if (this.isPrivate && user.isAnonymous) return undefined;
    const partition =
      this.isPrivate && user.isAuthenticated && !user.isAdmin
        ? user.userId
        : '__shared__';

    const raw = await this.storage.getRawRecord(this.name, partition, id);
    if (!raw || raw.deleted || !this.canRead(user, raw)) return undefined;

    const resolver = new UserResolver(this.storage);
    return sanitizeStoredRecord(raw, resolver, user);
  }

  /**
   * Retrieves all active records in this table for a user.
   *
   * @param user - Target user handle.
   * @returns Array of public SnapshotRecord items.
   */
  async getAllRecords(user: User): Promise<SnapshotRecord[]> {
    if (!this.canRead(user)) return [];
    if (this.isPrivate && user.isAnonymous) return [];
    const partition =
      this.isPrivate && user.isAuthenticated && !user.isAdmin
        ? user.userId
        : '__shared__';

    const rawRecords = await this.storage.getRawRecords(this.name, partition);
    const resolver = new UserResolver(this.storage);
    const records: SnapshotRecord[] = [];

    for (const raw of rawRecords) {
      if (raw.deleted || !this.canRead(user, raw)) continue;
      const userName = await resolver.resolveUserName(raw.userId, user);
      const rec: SnapshotRecord = {
        table: this.name,
        id: raw.id,
        data: raw.data,
        version: raw.version,
        timestamp: raw.timestamp,
      };
      if (raw.deleted) rec.deleted = true;
      if (raw.clientId !== undefined) rec.clientId = raw.clientId;
      if (userName !== undefined) rec.userName = userName;
      records.push(rec);
    }
    return records;
  }

  /**
   * Applies an array of mutation change operations to this table for a user.
   *
   * @param user - Target user handle.
   * @param changes - Array of change records to apply.
   * @returns Applied changes and new sequence number.
   */
  async applyChanges(
    user: User,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    const targeted = changes.map((c) => ({
      ...c,
      table: this.name,
    }));
    return this.storage.applyChanges(user, targeted);
  }

  /**
   * Inserts initial rows into this table if they do not already exist.
   *
   * @param rows - Array of table rows to insert.
   * @returns Number of new rows inserted.
   */
  async insertRows(rows: TableRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const existing = await this.getAllRecords(User.Admin);
    const existingIds = new Set(existing.map((r) => r.id));
    const toInsert = rows.filter((r) => !existingIds.has(r.id));
    if (toInsert.length === 0) return 0;

    const now = Date.now();
    for (const item of toInsert) {
      let authorUser: User = User.Admin;
      if (item.userName) {
        const user = await this.storage.getUserByUserName(item.userName);
        if (user) {
          authorUser = user;
        }
      }
      const change: ChangeRecord = {
        table: this.name,
        id: item.id,
        op: OperationType.Put,
        data: item.data,
        timestamp: now,
      };
      await this.applyChanges(authorUser, [change]);
    }
    return toInsert.length;
  }

  /**
   * Deletes this table and its data.
   *
   * @returns True if deleted successfully.
   */
  async delete(): Promise<boolean> {
    return this.storage.deleteTable(this.name);
  }

  // -- Private Helpers --------------------------------------------------------

  private canAccess(permission: Permission, user: User): boolean {
    if (user.isAdmin) return true;
    return (
      permission === Permission.Everybody ||
      (user.isAuthenticated && permission !== Permission.Nobody)
    );
  }
}
