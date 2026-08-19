# TetherDB 🚀

**TetherDB** is a lightweight, offline-first TypeScript library combining a reactive IndexedDB client wrapper with real-time two-way WebSocket synchronization against a server backend.

## Features

- **Offline-First & Local-First**: Operations are applied to IndexedDB immediately, queued in an outbox, and transparently synced in the background.
- **Multi-Application on Standard Domain**: Host multiple independent web apps on a single TetherDB server instance (e.g. `store.mysite.com`). Data and real-time broadcasts are isolated by `appId`.
- **Application & User Management**: Declare apps, active tables, and users programmatically (`declareApp()`, `declareUser()`) or via CLI commands (`apps`, `tables`, `users`).
- **Zero-Config Server Starter & CLI**: Start in one line with `startServer()` or run directly via `npx tetherdb --sqlite=./data` or `npx tetherdb --file=./data`.
- **Seamless Local-to-Synced Onboarding**: Start offline with zero-config local storage, then attach cloud sync with a single `client.register()` or `client.login()` call.
- **Batch-by-Default Architecture**: High-throughput atomic mutations (`putAll`, `deleteAll`, `getAll`) and coalesced WebSocket transmission.
- **Client-First Synchronization**: On first load or cache-miss, the client receives the complete dataset snapshot. On reconnect, it catches up with delta diffs.
- **Adaptive Snapshot Delivery & Compaction**: Compacts changelog history and automatically falls back to full snapshots when changelog windows are exceeded.
- **Last-Write-Wins (LWW) Conflict Resolution**: Monotonic logical clocks and deterministic tie-breaking.
- **Real-Time Broadcast**: Server broadcasts incoming changes in real-time to all other active client instances belonging to the same app and user.
- **Pluggable Server Storage**: Persistent SQLite storage (`SqliteStorage`), sharded filesystem storage (`FileStorage`), and ephemeral in-memory storage (`MemoryStorage`).
- **Simple, Secure Auth**: Built-in account registration, password hashing (scrypt with salt), and HMAC-signed tokens.
- **Modern Subpath Exports**: Import cleanly via `tetherdb/client`, `tetherdb/server`, `tetherdb/cli`, and `tetherdb/shared`.

## Installation

```bash
npm install tetherdb
```

## Quick Start

### 1. Zero-Config Standard Server

You can launch a TetherDB server instantly from the command line:

```bash
# Run standalone server CLI with SQLite persistence
npx tetherdb --sqlite=./data --port=8080
```

Or programmatically in TypeScript:

```typescript
import { SqliteStorage, startServer } from 'tetherdb/server';

const running = await startServer({
  port: 8080,
  storage: new SqliteStorage({ baseDir: './data' }),
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
const client = new TetherClient('todo-app', {
  host: 'localhost',
  port: 8080,
});
const todos = client.table<Todo>('todos');

// Reactive subscription to local & remote changes
const unsubscribe = todos.onChange.register((events) => {
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
client.onSyncStatusChange.register((status) => {
  console.log('Sync status:', status);
});
```

## HTTP Endpoints

The standard server provides authentication and WebSocket sync endpoints:

| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `POST` | `/auth/register` | Register a new user account | No |
| `POST` | `/auth/login` | Log in and receive signed session token | No |
| `WS` | `/sync` | Two-way WebSocket real-time synchronization | Token handshake in auth message |

---

## Architecture & Subpaths

- **`tetherdb/client`**: Reactive local-first client layer providing IndexedDB storage, CRUD tables, authentication state, and automatic WebSocket synchronization.
- **`tetherdb/server`**: Backend server coordinator handling HTTP authentication endpoints, WebSocket sync routing, and pluggable storage engines (memory, file, and SQLite).
- **`tetherdb/cli`**: Command-line administrative interface and runner for launching servers and managing applications, tables, and user accounts.
- **`tetherdb/shared`**: Shared protocol schemas, message formats, and path normalization utilities used across client and server packages.

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
