/**
 * TetherDB Server — Modular storage, crypto, sync hub, and HTTP server.
 *
 * @module tetherdb/server
 */
export {
  Permission,
  PROTOCOL_VERSION,
  type TablePermissions,
  type TableRow,
  type TableSettings,
} from '../shared/types.js';
export {
  AdminClient,
  type AdminTarget,
  LocalAdminTarget,
  type ResolvedAdminContext,
} from './admin.js';
export {
  TetherServerError,
  TetherServerErrorCode,
} from './errors.js';
export {
  acquireServerLock,
  readServerLock,
  type ServerLockHandle,
  type ServerLockInfo,
} from './lock.js';
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
  BaseStorage,
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
  TableBaseStorage,
  type TableStorage,
  UserBaseStorage,
  type UserStorage,
} from './storage/index.js';
