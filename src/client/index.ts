/**
 * TetherDB Client — Reactive IndexedDB wrapper with offline-first synchronization.
 *
 * @module tetherdb/client
 */

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
  SyncStatus,
  type WebSocketConstructor,
} from './sync.js';
export {
  type ITable,
  Table,
  type TableChangeEvent,
  type TableChangeListener,
  type TablePutEntry,
} from './table.js';
