/**
 * Table access control policies and permission rules.
 *
 * @module tetherdb/shared/types/permissions
 */

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
  create: Permission;
  /** Permission required to read rows and receive sync streams. */
  read: Permission;
  /** Permission required to update existing rows. */
  update: Permission;
  /** Permission required to delete existing rows. */
  delete: Permission;
}

/**
 * User-private table permissions: data is isolated per-user, and each user only reads and mutates their own records.
 */
export const USER_PRIVATE_PERMISSIONS: Readonly<TablePermissions> = {
  create: Permission.Authenticated,
  read: Permission.Owner,
  update: Permission.Owner,
  delete: Permission.Owner,
};

/**
 * Public-read table permissions: readable by everyone (including guests), creatable by authenticated users, and updatable/deletable by record owners.
 */
export const PUBLIC_READ_PERMISSIONS: Readonly<TablePermissions> = {
  create: Permission.Authenticated,
  read: Permission.Everybody,
  update: Permission.Owner,
  delete: Permission.Owner,
};

/**
 * Public-read-write table permissions: open collaboration where all operations are permitted without authentication.
 */
export const PUBLIC_READ_WRITE_PERMISSIONS: Readonly<TablePermissions> = {
  create: Permission.Everybody,
  read: Permission.Everybody,
  update: Permission.Everybody,
  delete: Permission.Everybody,
};

/**
 * Shared table permissions: readable and creatable by any authenticated user, while updates and deletes are restricted to the record author/owner.
 */
export const SHARED_PERMISSIONS: Readonly<TablePermissions> = {
  create: Permission.Authenticated,
  read: Permission.Authenticated,
  update: Permission.Owner,
  delete: Permission.Owner,
};

/**
 * Default table CRUD permissions when not explicitly configured (alias to `USER_PRIVATE_PERMISSIONS`).
 */
export const DEFAULT_TABLE_PERMISSIONS = USER_PRIVATE_PERMISSIONS;
