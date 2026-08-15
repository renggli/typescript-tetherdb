# BeamedDB 🚀

**BeamedDB** is a lightweight, offline-first TypeScript library combining a reactive IndexedDB client wrapper with real-time two-way WebSocket synchronization against a server backend.

## Features

- **Offline-First & Local-First**: Operations are applied to IndexedDB immediately, queued in an outbox, and transparently synced in the background.
- **Seamless Local-to-Synced Onboarding**: Start offline with zero-config local storage, then attach cloud sync with a single `db.register()` or `db.login()` call.
- **Batch-by-Default Architecture**: High-throughput atomic mutations (`putAll`, `deleteAll`, `getAll`) and coalesced WebSocket transmission.
- **Client-First Synchronization**: On first load or cache-miss, the client receives the complete dataset snapshot. On reconnect, it catches up with delta diffs.
- **Adaptive Snapshot Delivery & Compaction**: Compacts changelog history and automatically falls back to full snapshots when changelog windows are exceeded.
- **Last-Write-Wins (LWW) Conflict Resolution**: Monotonic logical clocks and deterministic tie-breaking.
- **Real-Time Broadcast**: Server broadcasts incoming changes in real-time to all other active client instances belonging to the same user.
- **Sharded & Secure File Storage**: Persists data per user in sharded directories (`<baseDir>/<shard>/<userId>/stores/`) with path confinement and injection defenses.
- **Simple, Secure Auth**: Built-in account registration, password hashing (scrypt with salt), and HMAC-signed tokens.
- **Modern Subpath Exports**: Import cleanly via `beameddb/client`, `beameddb/server`, and `beameddb/shared`.

---

## Installation

```bash
npm install beameddb
```

---

## Quick Start

### 1. Server Setup

```typescript
import { BeamedServer, FileStorageAdapter } from "beameddb/server";

// Start BeamedDB server with file-based persistence
const server = new BeamedServer({
  storage: new FileStorageAdapter({ baseDir: "./data/users" }),
  // Or simply pass `storageDir: "./data/users"`
});

const httpServer = await server.listen(8080, "0.0.0.0");
console.log("BeamedDB server running at http://localhost:8080");
```

### 2. Client Usage: Offline-First to Real-Time Sync

```typescript
import { BeamedClientDB } from "beameddb/client";

interface Todo {
  title: string;
  completed: boolean;
}

// 1. Initialize local database with zero configuration
const db = new BeamedClientDB({ name: "my-app-db" });
const todos = db.table<Todo>("todos");

// Reactive subscription to local & remote changes (always receives a list of TableChangeEvent)
const unsubscribe = todos.subscribe((events) => {
  for (const { op, id, data, isRemote } of events) {
    console.log(`Change (${op}) on ${id}, isRemote: ${isRemote}:`, data);
  }
});

// Write locally right away
await todos.put("task-1", {
  title: "Build awesome app",
  completed: false,
});

// Bulk put (atomic IDB transaction)
await todos.putAll([
  { id: "task-2", data: { title: "Write tests", completed: false } },
  { id: "task-3", data: { title: "Deploy", completed: false } },
]);

// Read items
const task = await todos.get("task-1");
const subset = await todos.getAll(["task-1", "task-2"]);
const allTasks = await todos.getAll();

// 2. Connect sync seamlessly when user registers or logs in
await db.register({
  serverUrl: "http://localhost:8080",
  username: "alice",
  password: "mypassword",
});

// Monitor live synchronization status
db.onSyncStatusChange((status) => {
  console.log("Sync status:", status); // 'connected', 'connecting', 'disconnected', 'error'
});
```

---

## Architecture & Subpaths

- **`beameddb/client`**:
  - `BeamedClientDB`: Main database client with local-first storage, dynamic sync, and auth helpers.
  - `Table`: Typed table wrapper around IndexedDB object stores supporting single and bulk CRUD (`put`, `putAll`, `delete`, `deleteAll`, `get`, `getAll`, `clear`).
  - `BeamedSyncClient`: Real-time WebSocket sync manager with debounced outbox draining.
  - `BeamedAuthClient`: Lightweight HTTP client for authentication endpoints.
  - `IDBManager`: IndexedDB layer with outbox and metadata stores.
- **`beameddb/server`**:
  - `BeamedServer`: Unified HTTP and WebSocket server.
  - `AuthManager`: User registration, credential verification, and token generation.
  - `SyncHub`: WebSocket connection manager with user-level change routing and broadcasting.
  - `FileStorageAdapter`: Persists data per user in sharded subdirectories (`<baseDir>/<shard>/<userId>/stores/`).
  - `MemoryStorageAdapter`: In-memory storage adapter for testing and ephemeral workloads.
  - `StorageAdapter`: Pluggable storage adapter interface.
- **`beameddb/shared`**:
  - Shared types (`ChangeRecord`, `StoredRecord`, `ClientMessage`, `ServerMessage`, `ServerLimits`).
  - Security validators (`validateUserId`, `validateStoreName`, `validateRecordId`, `validateUsername`).
  - Clock utilities (`shouldOverwrite`, `generateClientId`).

---

## Example Todo Application

BeamedDB includes a full-featured, offline-first collaborative Todo application in `examples/todo/` demonstrating real-time synchronization across multiple browser tabs:

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
