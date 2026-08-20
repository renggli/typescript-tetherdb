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

/**
 * Backend persistence type for TetherDB server.
 */
export type BackendType = 'memory' | 'file' | 'sqlite';

/**
 * Instantiates the matching Storage implementation for a given backend type and directory.
 *
 * @param backend - Target backend ('memory', 'file', or 'sqlite'). Defaults to 'memory'.
 * @param baseDir - Directory path for file and sqlite backends. Defaults to '.data'.
 * @param options - Optional storage configuration and limits.
 * @returns Instantiated `Storage` engine.
 */
export function createBackend(
  backend: BackendType = 'memory',
  baseDir = '.data',
  options?: StorageOptions,
): Storage {
  const resolvedDir = path.resolve(baseDir);
  switch (backend) {
    case 'memory':
      return new MemoryStorage(options);
    case 'sqlite':
      return new SqliteStorage({ baseDir: resolvedDir, ...options });
    case 'file':
      return new FileStorage({ baseDir: resolvedDir, ...options });
    default:
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        `Unknown backend type: "${backend}". Expected 'memory', 'file', or 'sqlite'`,
      );
  }
}
