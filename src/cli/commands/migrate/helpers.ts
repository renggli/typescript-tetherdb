import * as fs from 'node:fs';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../../server/errors.js';
import { readServerLock } from '../../../server/shared/lock.js';

/**
 * Asserts that the database is offline (no running server lock).
 *
 * @param dir - Target base directory.
 */
export function assertDatabaseIsOffline(dir: string): void {
  const lock = readServerLock(dir);
  if (lock && lock.pid !== process.pid) {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      `Cannot migrate database while server is running (PID ${lock.pid}). Please stop the server before migrating.`,
    );
  }
}

/**
 * Extracts optional `--app=<appId>` filter from positional arguments.
 *
 * @param args - Command line arguments.
 * @returns Application filter string or undefined.
 */
export function parseAppOption(args: string[]): string | undefined {
  for (const arg of args) {
    if (arg.startsWith('--app=')) {
      return arg.slice(6);
    }
  }
  return undefined;
}

/**
 * Renames an existing file to `.v1.bak` as a safety backup.
 *
 * @param filePath - Path to file to back up.
 */
export function backupFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.renameSync(filePath, `${filePath}.v1.bak`);
    }
  } catch {
    // Ignore backup failure
  }
}

/**
 * Filters the list of applications by an optional application ID.
 *
 * @param apps - List of apps containing `id`.
 * @param appFilter - Optional app ID to filter by.
 * @returns Filtered apps list.
 */
export function filterTargetApps<T extends { id: string }>(
  apps: T[],
  appFilter?: string,
): T[] {
  const targetApps = appFilter ? apps.filter((a) => a.id === appFilter) : apps;

  if (appFilter && targetApps.length === 0) {
    throw new TetherServerError(
      TetherServerErrorCode.NotFound,
      `Application "${appFilter}" not found in v1 database`,
    );
  }

  return targetApps;
}
