/**
 * Table-level permission policy.
 */
export enum Permission {
  /** Accessible by both unauthenticated guests and authenticated users. */
  Everybody = 'everybody',
  /** Accessible by any authenticated user. */
  Authenticated = 'authenticated',
  /** Accessible only by the owner or partitioned per user. */
  Owner = 'owner',
  /** Disallowed for all client operations. */
  Nobody = 'nobody',
}

/**
 * Static table CRUD permissions declared on table settings.
 */
export interface TablePermissions {
  /** Permission required to create new rows. */
  create?: Permission;
  /** Permission required to read rows and receive sync streams. */
  read?: Permission;
  /** Permission required to update existing rows. */
  update?: Permission;
  /** Permission required to delete existing rows. */
  delete?: Permission;
}

/**
 * Configuration options, resource limits, and access policies for a table.
 */
export interface TableSettings {
  /** Table CRUD permissions. */
  permissions?: TablePermissions;
  /** Maximum number of active records per partition or shared table. */
  maxRecords?: number;
  /** Maximum allowed payload size in bytes for an individual record. */
  maxRecordSizeBytes?: number;
  /** Maximum changelog history entries retained per partition before compaction. */
  maxHistoryEntries?: number;
}
