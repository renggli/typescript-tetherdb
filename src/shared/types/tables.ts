/**
 * Table schema configuration, declarative seed rows, and storage limits.
 *
 * @module tetherdb/shared/types/tables
 */

import type { TablePermissions } from './permissions.js';

/**
 * Initial row item for declarative table population.
 */
export interface TableRow<T = unknown> {
  /** Unique record identifier. */
  id: string;
  /** Stored value payload. */
  data: T;
  /** Optional username of the row's owner. */
  userName?: string;
}

/**
 * Configuration options, resource limits, and access policies for a table.
 */
export interface TableSettings {
  /** Table CRUD permissions. */
  permissions: TablePermissions;
  /** Initial rows to populate declaratively on table creation/startup. */
  rows?: TableRow[];
  /** Maximum number of active records per partition or shared table. */
  maxRecords?: number;
  /** Maximum allowed payload size in bytes for an individual record. */
  maxRecordSizeBytes?: number;
  /** Maximum changelog history entries retained per partition before compaction. */
  maxHistoryEntries?: number;
}
