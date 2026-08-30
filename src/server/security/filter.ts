import {
  type ChangeRecord,
  OperationType,
  Permission,
  type SnapshotRecord,
  type StoredRecord,
} from '../../shared/types.js';
import type { Table } from '../storage/table.js';
import type { User } from '../storage/user.js';
import type { UserResolver } from './resolver.js';
import type { InternalChangeRecord, InternalStoredRecord } from './types.js';

/**
 * Checks whether an actor permission rule permits access for a given user and record owner.
 *
 * @param permission - Permission requirement level.
 * @param user - Authenticated user context.
 * @param recordUserId - Record owner user ID.
 * @returns `true` if access is granted.
 */
export function isPermissionAllowed(
  permission: Permission,
  user?: User,
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
 * Sanitizes and fattens an internal stored record into a public StoredRecord schema,
 * stripping internal userId and attaching resolved userName.
 *
 * @param raw - Internal stored record.
 * @param resolver - UserResolver instance.
 * @param fallbackUser - Optional authenticated user context.
 * @returns Public StoredRecord object with no internal fields.
 */
export async function sanitizeStoredRecord<T = unknown>(
  raw: InternalStoredRecord<T>,
  resolver: UserResolver,
  fallbackUser?: User,
): Promise<StoredRecord<T>> {
  const userName = await resolver.resolveUserName(raw.userId, fallbackUser);
  const record: StoredRecord<T> = {
    id: raw.id,
    data: raw.data,
    version: raw.version,
    timestamp: raw.timestamp,
  };
  if (raw.deleted) record.deleted = true;
  if (raw.clientId !== undefined) record.clientId = raw.clientId;
  if (userName !== undefined) record.userName = userName;
  return record;
}

/**
 * Filters readable tables/records and produces a sanitized, fattened snapshot payload.
 *
 * @param tables - Array of available Table handles.
 * @param user - Target authenticated user or guest.
 * @param resolver - UserResolver instance.
 * @param tableFilters - Optional table name filter.
 * @returns Array of public SnapshotRecord objects.
 */
export async function filterAndSanitizeSnapshot(
  tables: Table[],
  user: User | undefined,
  resolver: UserResolver,
  tableFilters?: string[],
): Promise<SnapshotRecord[]> {
  const snapshot: SnapshotRecord[] = [];

  for (const table of tables) {
    if (!table.canRead(user)) continue;
    if (tableFilters && !tableFilters.includes(table.name)) continue;

    const partition = table.isPrivate ? user?.userId : '__shared__';
    if (!partition) continue;

    const rawRecords = await table.storage.getRawRecords(table.name, partition);
    for (const raw of rawRecords) {
      if (raw.deleted || !table.canRead(user, raw)) continue;
      const userName = await resolver.resolveUserName(raw.userId, user);
      const item: SnapshotRecord = {
        table: table.name,
        id: raw.id,
        data: raw.data,
        version: raw.version,
        timestamp: raw.timestamp,
      };
      if (raw.deleted) item.deleted = true;
      if (raw.clientId !== undefined) item.clientId = raw.clientId;
      if (userName !== undefined) item.userName = userName;
      snapshot.push(item);
    }
  }

  return snapshot;
}

/**
 * Filters changelog mutations and produces a sanitized, fattened ChangeRecord array.
 *
 * @param rawChanges - Raw internal change records from storage.
 * @param user - Target recipient user.
 * @param tableLookup - Table resolution function.
 * @param resolver - UserResolver instance.
 * @param tableFilters - Optional table name filter.
 * @returns Array of public ChangeRecord objects.
 */
export async function filterAndSanitizeChanges(
  rawChanges: InternalChangeRecord[],
  user: User | undefined,
  tableLookup: (name: string) => Promise<Table | undefined> | Table | undefined,
  resolver: UserResolver,
  tableFilters?: string[],
): Promise<ChangeRecord[]> {
  const changes: ChangeRecord[] = [];
  const tableCache = new Map<string, Table | undefined>();

  for (const raw of rawChanges) {
    if (tableFilters && !tableFilters.includes(raw.table)) continue;

    let table = tableCache.get(raw.table);
    if (!table && !tableCache.has(raw.table)) {
      table = await tableLookup(raw.table);
      tableCache.set(raw.table, table);
    }

    if (!table?.canRead(user)) continue;
    if (table.isPrivate && (!user || raw.userId !== user.userId)) continue;
    if (!table.canRead(user, { userId: raw.userId } as InternalStoredRecord)) {
      continue;
    }

    const userName = await resolver.resolveUserName(raw.userId, user);
    const isDeleted = raw.op === OperationType.Delete;

    const change: ChangeRecord = {
      table: raw.table,
      id: raw.id,
      op: raw.op,
      version: raw.version,
      seq: raw.seq,
      timestamp: raw.timestamp,
    };
    if (!isDeleted && raw.data !== undefined) change.data = raw.data;
    if (raw.clientId !== undefined) change.clientId = raw.clientId;
    if (userName !== undefined) change.userName = userName;

    changes.push(change);
  }

  return changes;
}
