import type {
  ChangeRecord,
  RecordSnapshotItem,
  StoredRecord,
} from '../../shared/types.js';

/**
 * Pluggable server-side storage abstraction managing user-isolated database records
 * and incremental changelog histories.
 */
export interface StorageAdapter {
  /**
   * Retrieves a single stored record by table and identifier for a user.
   *
   * @param userId - Target user account identifier.
   * @param store - Table/store name.
   * @param id - Record identifier.
   * @returns Stored record or `undefined` if not found.
   */
  getRecord(
    userId: string,
    store: string,
    id: string,
  ): Promise<StoredRecord | undefined>;

  /**
   * Retrieves all active records across all stores (or for a specific store) for a user.
   *
   * @param userId - Target user account identifier.
   * @param store - Optional specific table name to filter records.
   * @returns Array of snapshot record items.
   */
  getAllRecords(userId: string, store?: string): Promise<RecordSnapshotItem[]>;

  /**
   * Applies an array of mutation change operations applying Last-Write-Wins rules,
   * assigning sequential change numbers, and appending to the user's changelog.
   *
   * @param userId - Target user account identifier.
   * @param changes - Array of change records to apply.
   * @returns Object containing the applied changes with sequence numbers and the new current sequence number.
   */
  applyChanges(
    userId: string,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }>;

  /**
   * Retrieves all change operations recorded for a user since a given sequence number.
   * If the requested `fromSeq` is older than the compacted changelog retention window,
   * `requiresSnapshot` will be true, indicating the client should receive a full snapshot instead.
   *
   * @param userId - Target user account identifier.
   * @param fromSeq - Starting sequence number (exclusive).
   * @returns Array of applied change records, current sequence number, and optional snapshot requirement flag.
   */
  getChangesSince(
    userId: string,
    fromSeq: number,
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }>;

  /**
   * Retrieves the current global sequence number for a user's dataset.
   *
   * @param userId - Target user account identifier.
   * @returns Current integer sequence number.
   */
  getCurrentSeq(userId: string): Promise<number>;

  /**
   * Optional cleanup callback invoked when shutting down the storage adapter.
   */
  close?(): Promise<void>;
}
