import type { ChangeRecord } from '../../shared/types.js';
import type { TableStorage } from './table.js';
import type { UserStorage } from './user.js';

/**
 * Application namespace storage managing tables, batch changelogs, and user sequence counters.
 */
export interface AppStorage {
  /** Application namespace identifier. */
  readonly id: string;

  /**
   * Creates/registers a new table within this application.
   *
   * @param name - Name of the table.
   * @returns TableStorage handle.
   */
  createTable(name: string): Promise<TableStorage>;

  /**
   * Retrieves a table handle if it exists.
   *
   * @param name - Name of the table.
   * @returns TableStorage handle or `undefined`.
   */
  getTable(name: string): Promise<TableStorage | undefined>;

  /**
   * Lists all registered tables in this application.
   *
   * @returns Array of TableStorage handles.
   */
  getTables(): Promise<TableStorage[]>;

  /**
   * Applies an array of mutation changes for a user applying LWW conflict resolution,
   * assigning sequential change numbers, and appending to the changelog.
   *
   * @param user - Target user handle.
   * @param changes - Array of change records.
   * @returns Applied changes with assigned sequence numbers and new sequence number.
   */
  applyChanges(
    user: UserStorage,
    changes: ChangeRecord[],
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }>;

  /**
   * Retrieves change operations for a user since a given sequence number within this app.
   *
   * @param user - Target user handle.
   * @param fromSeq - Starting sequence number (exclusive).
   * @returns Changes, current sequence, and snapshot requirement flag.
   */
  getChangesSince(
    user: UserStorage,
    fromSeq: number,
  ): Promise<{
    changes: ChangeRecord[];
    currentSeq: number;
    requiresSnapshot?: boolean;
  }>;

  /**
   * Returns the current global sequence number for a user within this application.
   *
   * @param user - Target user handle.
   * @returns Current integer sequence number.
   */
  getCurrentSeq(user: UserStorage): Promise<number>;

  /**
   * Deletes this entire application and all associated data across all users and tables.
   *
   * @returns True if deleted successfully.
   */
  delete(): Promise<boolean>;
}
