/**
 * TetherDB Server — Modular storage, crypto, sync hub, HTTP server, and CLI.
 *
 * @module tetherdb/server
 */

export {
  type BackendType,
  createBackend,
  runCli,
} from './cli.js';
export {
  createSessionToken,
  hashPassword,
  verifyPasswordHash,
  verifySessionToken,
} from './crypto.js';
export {
  TetherServerError,
  TetherServerErrorCode,
} from './errors.js';
export {
  type RunningServer,
  type StartServerOptions,
  startServer,
  TetherServer,
  type TetherServerOptions,
} from './server.js';
export {
  type AppStorage,
  FileStorage,
  type FileStorageOptions,
  MemoryStorage,
  type MemoryStorageOptions,
  SqliteStorage,
  type SqliteStorageOptions,
  type Storage,
  type StorageOptions,
  type TableStorage,
  type UserStorage,
} from './storage/index.js';
export { Sync } from './sync.js';
