import * as path from 'node:path';
import {
  FileStorage,
  MemoryStorage,
  SqliteStorage,
  type Storage,
  type StorageOptions,
  TetherServerError,
  TetherServerErrorCode,
} from '../server/index.js';
import { BackendType } from '../shared/types.js';

export { BackendType };

/**
 * Instantiates the matching Storage implementation for a given backend type and directory.
 *
 * @param backend - Target backend ('memory', 'file', or 'sqlite'). Defaults to 'memory'.
 * @param baseDir - Directory path for file and sqlite backends. Defaults to '.data'.
 * @param options - Optional storage configuration and limits.
 * @returns Instantiated `Storage` engine.
 */
export function createBackend(
  backend: BackendType = BackendType.Memory,
  baseDir = '.data',
  options?: StorageOptions,
): Storage {
  const resolvedDir = path.resolve(baseDir);
  switch (backend) {
    case BackendType.Memory:
      return new MemoryStorage(options);
    case BackendType.Sqlite:
      return new SqliteStorage({ baseDir: resolvedDir, ...options });
    case BackendType.File:
      return new FileStorage({ baseDir: resolvedDir, ...options });
    default:
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        `Unknown backend type: "${backend}". Expected 'memory', 'file', or 'sqlite'`,
      );
  }
}
