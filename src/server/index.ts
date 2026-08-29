/**
 * TetherDB Server — Modular storage, crypto, sync hub, and HTTP server.
 *
 * @module tetherdb/server
 */
export {
  Permission,
  PUBLIC_READ_PERMISSIONS,
  PUBLIC_READ_WRITE_PERMISSIONS,
  SHARED_PERMISSIONS,
  type TablePermissions,
  type TableRow,
  type TableSettings,
  USER_PRIVATE_PERMISSIONS,
} from '../shared/types.js';
export {
  TetherServerError,
  TetherServerErrorCode,
} from './errors.js';
export {
  type CorsOptions,
  type RateLimitOptions,
  type RunningServer,
  type StartServerOptions,
  startServer,
  type TetherLogger,
  TetherServer,
  type TetherServerOptions,
} from './server.js';
export {
  BackendType,
  FileStorage,
  type FileStorageOptions,
  type MaintenanceResult,
  MemoryStorage,
  type MemoryStorageOptions,
  SqliteStorage,
  type SqliteStorageOptions,
  type Storage,
  type StorageOptions,
  type StorageStatus,
  type TableStorage,
  type UserStorage,
} from './storage/index.js';
