import type {
  ChangeRecord,
  SnapshotRecord,
  StoredRecord,
  TableSettings,
} from '../../shared/types.js';
import type { UserStorage } from './user.js';

/**
 * Table-scoped storage interface for record CRUD, settings, and batch mutation processing.
 */
export interface TableStorage {
  /** Table name identifier. */
  readonly name: string;
  /** Current table configuration settings, limits, and access policies. */
  readonly settings: TableSettings;

  /**
   * Updates table settings dynamically.
   *
   * @param settings - Partial table settings to merge.
   * @returns Updated TableSettings.
   */
  updateSettings(settings: Partial<TableSettings>): Promise<TableSettings>;

  /**
   * Retrieves a single stored record by ID for a user.
   *
   * @param user - Target user handle (if user-private or shared).
   * @param id - Record identifier.
   * @returns Stored record or `undefined` if not found or deleted.
   */
  getRecord(
    user: UserStorage | undefined,
    id: string,
  ): Promise<StoredRecord | undefined>;

  /**
   * Retrieves all active (non-deleted) records in this table for a user.
   *
   * @param user - Target user handle.
   * @returns Array of snapshot items.
   */
  getAllRecords(user?: UserStorage): Promise<SnapshotRecord[]>;

  /**
   * Applies an array of mutation change operations to this table for a user.
   *
   * @param user - Target user handle.
   * @param changes - Array of change records.
   * @returns Applied changes and new sequence number.
   */
  applyChanges(
    user: UserStorage | undefined,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }>;

  /**
   * Deletes this table and its data.
   *
   * @returns True if deleted successfully.
   */
  delete(): Promise<boolean>;
}
