import type {
  ChangeRecord,
  SnapshotRecord,
  StoredRecord,
} from '../../shared/types.js';
import type { AppStorage } from './app.js';
import type { UserStorage } from './user.js';

/**
 * Table-scoped storage interface for record CRUD and batch mutation processing.
 */
export interface TableStorage {
  /** Table name identifier. */
  readonly name: string;
  /** Parent application storage handle. */
  readonly app: AppStorage;

  /**
   * Retrieves a single stored record by ID for a user.
   *
   * @param user - Target user handle.
   * @param id - Record identifier.
   * @returns Stored record or `undefined` if not found or deleted.
   */
  getRecord(user: UserStorage, id: string): Promise<StoredRecord | undefined>;

  /**
   * Retrieves all active (non-deleted) records in this table for a user.
   *
   * @param user - Target user handle.
   * @returns Array of snapshot items.
   */
  getAllRecords(user: UserStorage): Promise<SnapshotRecord[]>;

  /**
   * Applies an array of mutation change operations to this table for a user.
   *
   * @param user - Target user handle.
   * @param changes - Array of change records.
   * @returns Applied changes and new sequence number.
   */
  applyChanges(
    user: UserStorage,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }>;

  /**
   * Deletes this table and its data across all.
   *
   * @returns True if deleted successfully.
   */
  delete(): Promise<boolean>;
}
