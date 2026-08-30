import * as path from 'node:path';
import { TetherServerError, TetherServerErrorCode } from '../server/errors.js';
import { FileStorage } from '../server/storage/file.js';
import { MemoryStorage } from '../server/storage/memory.js';
import { SqliteStorage } from '../server/storage/sqlite.js';
import {
  type Storage,
  type StorageOptions,
  StorageType,
} from '../server/storage/storage.js';

export { StorageType };

/**
 * Instantiates the matching Storage implementation for a given backend type and directory.
 *
 * @param backend - Target backend ('memory', 'file', or 'sqlite'). Defaults to 'memory'.
 * @param baseDir - Directory path for file and sqlite backends. Defaults to '.data'.
 * @param options - Optional storage configuration and limits.
 * @returns Instantiated `Storage` engine.
 */
export function createBackend(
  backend: StorageType = StorageType.Memory,
  baseDir = '.data',
  options?: StorageOptions,
): Storage {
  const resolvedDir = path.resolve(baseDir);
  switch (backend) {
    case StorageType.Memory:
      return new MemoryStorage(options);
    case StorageType.Sqlite:
      return new SqliteStorage({ baseDir: resolvedDir, ...options });
    case StorageType.File:
      return new FileStorage({ baseDir: resolvedDir, ...options });
    default:
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        `Unknown backend type: "${backend}". Expected 'memory', 'file', or 'sqlite'`,
      );
  }
}
