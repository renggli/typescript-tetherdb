/**
 * TetherDB Client — Reactive IndexedDB wrapper with offline-first synchronization.
 *
 * @module tetherdb/client
 */

export {
  OperationType,
  type StoredRecord,
} from '../shared/types.js';
export {
  isValidTableName,
  TABLE_NAME_MAX_LENGTH,
  TABLE_NAME_PATTERN,
  type ValidTableName,
} from '../shared/validate.js';
export {
  AuthStatus,
  DataMode,
  type LoginOptions,
  type LogoutOptions,
  type RegisterOptions,
} from './auth.js';
export {
  TetherClient,
  type TetherClientOptions,
} from './client.js';
export {
  TetherClientError,
  TetherClientErrorCode,
} from './errors.js';
export {
  Index,
  IndexDirection,
  type IndexOptions,
  type IndexQueryOptions,
  IndexRange,
} from './indexed.js';
export {
  SyncStatus,
  type WebSocketConstructor,
} from './sync/types.js';
export {
  Table,
  type TableChangeEvent,
  type TableChangeListener,
  type TablePutEntry,
} from './table.js';
