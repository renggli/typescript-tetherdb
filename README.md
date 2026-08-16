# TetherDB 🚀

**TetherDB** is a lightweight, offline-first TypeScript library combining a reactive IndexedDB client wrapper with real-time two-way WebSocket synchronization against a server backend.

## Features

- **Offline-First & Local-First**: Operations are applied to IndexedDB immediately, queued in an outbox, and transparently synced in the background.
- **Multi-Application on Standard Domain**: Host multiple independent web apps on a single TetherDB server instance (e.g. `store.mysite.com`). Data and real-time broadcasts are isolated by `appId`.
- **Application & User Management**: Declare apps, active tables, and users programmatically (`declareApp()`, `declareUser()`) or via CLI commands (`apps`, `tables`, `users`).
- **Zero-Config Server Starter & CLI**: Start in one line with `startServer()` or run directly via `npx tetherdb --port 8080 --dir ./data`.
- **Seamless Local-to-Synced Onboarding**: Start offline with zero-config local storage, then attach cloud sync with a single `db.register()` or `db.login()` call.
- **Batch-by-Default Architecture**: High-throughput atomic mutations (`putAll`, `deleteAll`, `getAll`) and coalesced WebSocket transmission.
- **Client-First Synchronization**: On first load or cache-miss, the client receives the complete dataset snapshot. On reconnect, it catches up with delta diffs.
- **Adaptive Snapshot Delivery & Compaction**: Compacts changelog history and automatically falls back to full snapshots when changelog windows are exceeded.
- **Last-Write-Wins (LWW) Conflict Resolution**: Monotonic logical clocks and deterministic tie-breaking.
- **Real-Time Broadcast**: Server broadcasts incoming changes in real-time to all other active client instances belonging to the same app and user.
- **Sharded & Secure File Storage**: Persists data per app and user in sharded directories (`<baseDir>/<appId>/<shard>/<userId>/stores/`) with path confinement and injection defenses.
- **Simple, Secure Auth**: Built-in account registration, password hashing (scrypt with salt), and HMAC-signed tokens.
- **Modern Subpath Exports**: Import cleanly via `tetherdb/client`, `tetherdb/server`, and `tetherdb/shared`.

---

## Installation

```bash
npm install tetherdb
```

---

## Quick Start

### 1. Zero-Config Standard Server

You can launch a TetherDB server instantly from the command line:

```bash
# Run standalone server CLI
npx tetherdb --port 8080 --dir ./data
```

Or programmatically in two lines of TypeScript:

```typescript
import { startServer } from 'tetherdb/server';

const running = await startServer({
  port: 8080,
  storageDir: './data',
});
console.log(`TetherDB running at http://${running.host}:${running.port}`);
```

### 2. Client Usage: Multi-App Offline-First to Real-Time Sync

```typescript
import { TetherClient } from 'tetherdb/client';

interface Todo {
  title: string;
  completed: boolean;
}

// 1. Initialize local client scoped to your application
const client = new TetherClient({
  name: 'my-todos',
  appId: 'todo-app', // Partition data & sync channels per application
  host: 'localhost',
  port: 8080,
});
const todos = client.table<Todo>('todos');

// Reactive subscription to local & remote changes
const unsubscribe = todos.subscribe((events) => {
  for (const { op, id, data, isRemote } of events) {
    console.log(`Change (${op}) on ${id}, isRemote: ${isRemote}:`, data);
  }
});

// Write locally right away (offline-first)
await todos.put('task-1', {
  title: 'Build awesome app',
  completed: false,
});

// Bulk put (atomic IDB transaction)
await todos.putAll([
  { id: 'task-2', data: { title: 'Write tests', completed: false } },
  { id: 'task-3', data: { title: 'Deploy', completed: false } },
]);

// Read items
const task = await todos.get('task-1');
const allTasks = await todos.getAll();

// 2. Connect sync seamlessly when user registers or logs in
await client.register({
  username: 'alice',
  password: 'mypassword',
  remember: true, // Automatically restores session on next page reload
});

// Monitor live synchronization status
client.onSyncStatusChange((status) => {
  console.log('Sync status:', status);
});
```

---

## HTTP Endpoints
 
The standard server provides authentication, health, and WebSocket sync endpoints:

| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Server liveness check (`{ status: "ok" }`) | No |
| `POST` | `/auth/register` | Register a new user account | No |
| `POST` | `/auth/login` | Log in and receive signed session token | No |
| `WS` | `/sync` | Two-way WebSocket real-time synchronization | Token handshake in auth message |

---

## Architecture & Subpaths

- **`tetherdb/client`**:
  - `TetherClient`: Main reactive facade client with local-first storage, multi-app support, auto-session, and auth helpers.
  - `Table`: Typed table wrapper around IndexedDB object stores supporting single and bulk CRUD (`put`, `putAll`, `delete`, `deleteAll`, `get`, `getAll`, `clear`).
  - `Sync`: Real-time WebSocket sync coordinator with debounced outbox draining and exponential backoff.
  - `Auth`: Internal authentication coordinator managing sessions and metadata persistence.
  - `Database`: IndexedDB layer with outbox and metadata stores.



- **`tetherdb/server`**:
  - `startServer`: Zero-config server launcher with automatic port assignment and clean shutdown.
  - `TetherServer`: Unified HTTP and WebSocket server with discovery endpoints.
  - `AuthAdapter`: Pluggable authentication interface for custom identity providers.
  - `MemoryAuthAdapter`: In-memory auth adapter for fast testing and ephemeral workloads.
  - `FileAuthAdapter`: Filesystem-persisted auth adapter storing user credentials and secret keys.
  - `SyncHub`: WebSocket connection manager with app- and user-level change routing and broadcasting.
  - `FileStorageAdapter`: Multi-app sharded filesystem storage (`<baseDir>/<appId>/<shard>/<userId>/stores/`).
  - `MemoryStorageAdapter`: In-memory storage adapter for testing and ephemeral workloads.
- **`tetherdb/shared`**:
  - Shared types (`ChangeRecord`, `StoredRecord`, `ClientMessage`, `ServerMessage`).
  - Security validators (`validateUserId`, `validateAppId`, `validateStoreName`, `validateRecordId`, `validateUsername`).
  - Clock utilities (`shouldOverwrite`, `generateClientId`).

---

## Example Todo Application

TetherDB includes a full-featured, offline-first collaborative Todo application in `examples/todo/` demonstrating real-time synchronization across multiple browser tabs:

```bash
# Build library bundles and start the example server
npm run build
npm run example:todo
```

Then open `http://localhost:3000` in multiple browser tabs or windows to see instant bi-directional updates, offline persistence, and account switching.

---

## Running Tests & Building

```bash
# Auto-format and lint checks
npm run format
npm run check

# Run unit and end-to-end tests
npm test

# Typecheck
npm run typecheck

# Build bundle
npm run build
```
