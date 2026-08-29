import * as path from 'node:path';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../../server/errors.js';
import { BackendType } from '../../../server/storage/index.js';
import { migrateFileStorage } from './file.js';
import { assertDatabaseIsOffline, parseAppOption } from './helpers.js';
import { migrateSqliteStorage } from './sqlite.js';

/**
 * Result metrics returned after running a storage migration.
 */
export interface MigrationResult {
  /** Target backend engine. */
  backend: BackendType;
  /** Number of tables migrated. */
  migratedTables: number;
  /** Number of user partitions migrated. */
  migratedUsers: number;
  /** Number of records migrated across all tables and partitions. */
  migratedRecords: number;
  /** Number of changelog / sync entries migrated. */
  migratedChangelogEntries: number;
  /** Human-readable status message. */
  message: string;
}

/**
 * Handles the 'migrate' command to migrate an offline database from v1 to v2 format.
 *
 * @param positionalArgs - CLI arguments passed to the command.
 * @param backend - Storage backend type ('sqlite' | 'file').
 * @param dir - Target database directory.
 * @returns Result summary of the migration.
 */
export async function handleMigrateCommand(
  positionalArgs: string[] = [],
  backend: BackendType = BackendType.Sqlite,
  dir = '.data',
): Promise<MigrationResult> {
  const resolvedDir = path.resolve(dir);
  assertDatabaseIsOffline(resolvedDir);

  if (backend === BackendType.Memory) {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      'Migration is only supported for persistent storage backends (--sqlite or --file)',
    );
  }

  const appFilter = parseAppOption(positionalArgs);

  if (backend === BackendType.Sqlite) {
    const result = await migrateSqliteStorage(resolvedDir, appFilter);
    console.log(result.message);
    return result;
  }

  const result = await migrateFileStorage(resolvedDir, appFilter);
  console.log(result.message);
  return result;
}
