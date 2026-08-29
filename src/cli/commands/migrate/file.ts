import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../../server/errors.js';
import { getUserBucket } from '../../../server/shared/validate.js';
import { BackendType } from '../../../server/storage/index.js';
import type { StoredRecord } from '../../../shared/types.js';
import { backupFile, filterTargetApps } from './helpers.js';
import type { MigrationResult } from './index.js';

/**
 * Migrates a v1 multi-app FileStorage database to the v2 unified storage format.
 *
 * @param baseDir - Directory containing v1 FileStorage database files.
 * @param appFilter - Optional application identifier to migrate.
 * @returns Migration result statistics.
 */
export async function migrateFileStorage(
  baseDir: string,
  appFilter?: string,
): Promise<MigrationResult> {
  const appsJsonPath = path.join(baseDir, 'apps.json');
  const tablesJsonPath = path.join(baseDir, 'tables.json');

  if (!fs.existsSync(appsJsonPath)) {
    if (fs.existsSync(tablesJsonPath)) {
      return {
        backend: BackendType.File,
        migratedTables: 0,
        migratedUsers: 0,
        migratedRecords: 0,
        migratedChangelogEntries: 0,
        message:
          'Database is already on the current schema (v2). No migration required.',
      };
    }
    throw new TetherServerError(
      TetherServerErrorCode.NotFound,
      `No v1 File database found to migrate in "${baseDir}" (missing apps.json)`,
    );
  }

  const rawApps = await fs.promises.readFile(appsJsonPath, 'utf-8');
  const apps = JSON.parse(rawApps) as Array<{ id: string; createdAt: number }>;
  const targetApps = filterTargetApps(apps, appFilter);

  const tablesMap = new Map<
    string,
    { name: string; settings: Record<string, unknown>; createdAt: number }
  >();
  if (fs.existsSync(tablesJsonPath)) {
    try {
      const rawTables = await fs.promises.readFile(tablesJsonPath, 'utf-8');
      const list = JSON.parse(rawTables) as Array<{
        name: string;
        settings: Record<string, unknown>;
        createdAt: number;
      }>;
      for (const t of list) tablesMap.set(t.name, t);
    } catch {
      // Ignore
    }
  }

  let migratedTables = 0;
  let migratedUsers = 0;
  let migratedRecords = 0;
  let migratedChangelogEntries = 0;

  for (const app of targetApps) {
    const appDir = path.join(baseDir, app.id);
    const manifestPath = path.join(appDir, 'manifest.json');

    if (fs.existsSync(manifestPath)) {
      try {
        const rawManifest = await fs.promises.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(rawManifest) as {
          tables?: string[];
          createdAt?: number;
        };
        for (const tableName of manifest.tables ?? []) {
          if (!tablesMap.has(tableName)) {
            tablesMap.set(tableName, {
              name: tableName,
              settings: {},
              createdAt: manifest.createdAt ?? Date.now(),
            });
            migratedTables++;
          }
        }
      } catch {
        // Ignore
      }
    }

    const appUsersDir = path.join(appDir, 'users');
    if (!fs.existsSync(appUsersDir)) continue;

    const buckets = await fs.promises.readdir(appUsersDir, {
      withFileTypes: true,
    });
    for (const b of buckets) {
      if (!b.isDirectory()) continue;
      const bucketDir = path.join(appUsersDir, b.name);
      const users = await fs.promises.readdir(bucketDir, {
        withFileTypes: true,
      });

      for (const u of users) {
        if (!u.isDirectory()) continue;
        migratedUsers++;
        const userId = u.name;
        const userBucket = getUserBucket(userId);
        const userSrcDir = path.join(bucketDir, userId);
        const userDestDir = path.join(baseDir, 'users', userBucket, userId);
        await fs.promises.mkdir(userDestDir, { recursive: true });

        const srcTablesDir = path.join(userSrcDir, 'tables');
        if (fs.existsSync(srcTablesDir)) {
          const tableFiles = await fs.promises.readdir(srcTablesDir);
          for (const file of tableFiles) {
            if (!file.endsWith('.json')) continue;
            const tableName = path.basename(file, '.json');
            if (!tablesMap.has(tableName)) {
              tablesMap.set(tableName, {
                name: tableName,
                settings: {},
                createdAt: Date.now(),
              });
              migratedTables++;
            }

            const rawContent = await fs.promises.readFile(
              path.join(srcTablesDir, file),
              'utf-8',
            );
            try {
              const records = JSON.parse(rawContent) as StoredRecord[];
              migratedRecords += records.length;
              const destTableDir = path.join(userDestDir, tableName);
              await fs.promises.mkdir(destTableDir, { recursive: true });
              await fs.promises.writeFile(
                path.join(destTableDir, 'records.json'),
                JSON.stringify(records, null, 2),
                'utf-8',
              );
            } catch {
              // Ignore
            }
          }
        }

        const srcSyncPath = path.join(userSrcDir, 'sync.jsonl');
        if (fs.existsSync(srcSyncPath)) {
          const rawSync = await fs.promises.readFile(srcSyncPath, 'utf-8');
          const lines = rawSync
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
          migratedChangelogEntries += lines.length;
          await fs.promises.writeFile(
            path.join(userDestDir, 'sync.jsonl'),
            rawSync,
            'utf-8',
          );
        }

        const srcMetaPath = path.join(userSrcDir, 'meta.json');
        if (fs.existsSync(srcMetaPath)) {
          const rawMeta = await fs.promises.readFile(srcMetaPath, 'utf-8');
          await fs.promises.writeFile(
            path.join(userDestDir, 'meta.json'),
            rawMeta,
            'utf-8',
          );
        }
      }
    }
  }

  await fs.promises.writeFile(
    tablesJsonPath,
    JSON.stringify(Array.from(tablesMap.values()), null, 2),
    'utf-8',
  );

  backupFile(appsJsonPath);

  return {
    backend: BackendType.File,
    migratedTables,
    migratedUsers,
    migratedRecords,
    migratedChangelogEntries,
    message: `Filesystem migration completed: migrated ${migratedTables} table(s), ${migratedUsers} user partition(s), ${migratedRecords} record(s), and ${migratedChangelogEntries} changelog entries.`,
  };
}
