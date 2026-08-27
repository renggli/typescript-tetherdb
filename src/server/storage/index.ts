/**
 * TetherDB Server Storage — Modular storage architecture.
 *
 * @module tetherdb/server/storage
 */

export {
  BaseStorage,
  TableBaseStorage,
  UserBaseStorage,
} from './base/index.js';
export {
  FileStorage,
  type FileStorageOptions,
} from './file/storage.js';
export {
  MemoryStorage,
  type MemoryStorageOptions,
} from './memory/storage.js';
export {
  SqliteStorage,
  type SqliteStorageOptions,
} from './sqlite/storage.js';
export type {
  MaintenanceResult,
  Storage,
  StorageOptions,
  StorageStatus,
} from './storage.js';
export type { TableStorage } from './table.js';
export type { UserStorage } from './user.js';
