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
  create?: Permission;
  /** Permission required to read rows and receive sync streams. */
  read?: Permission;
  /** Permission required to update existing rows. */
  update?: Permission;
  /** Permission required to delete existing rows. */
  delete?: Permission;
}
