# BeamedDB 🚀

**BeamedDB** is a lightweight, offline-first TypeScript library combining a reactive IndexedDB client wrapper with real-time two-way WebSocket synchronization against a server backend.

## Features

- **Offline-First & Local-First**: Operations are applied to IndexedDB immediately, queued in an outbox, and transparently synced in the background.
- **Client-First Synchronization**: On first load or cache-miss, the client receives the complete dataset snapshot. On reconnect, it catches up with delta diffs.
- **Last-Write-Wins (LWW) Conflict Resolution**: Monotonic logical clocks and deterministic tie-breaking.
- **Real-Time Broadcast**: Server broadcasts incoming changes in real-time to all other active client instances belonging to the same user.
- **Pluggable & Per-User File Storage**: Includes `MemoryStorageAdapter` for zero-dependency testing and `FileStorageAdapter` for isolated per-user filesystem directories.
- **Simple, Secure Auth**: Built-in account registration, password hashing (scrypt), and signed tokens.
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

### 2. Client Registration & Authentication

```typescript
// Register an account
const response = await fetch("http://localhost:8080/auth/register", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "alice", password: "mypassword" })
});
const { user, token } = await response.json();
```

### 3. Client Database Usage

```typescript
import { BeamedClientDB } from "beameddb/client";

interface Todo {
  title: string;
  completed: boolean;
}

const db = new BeamedClientDB({
  name: "my-app-db",
  stores: ["todos"],
  sync: {
    url: "ws://localhost:8080/sync",
    token: token // Auth token from registration/login
  }
});

const todos = db.table<Todo>("todos");

// Reactive subscription to local & remote changes
const unsubscribe = todos.subscribe(({ op, id, data, isRemote }) => {
  console.log(`Change (${op}) on ${id}, isRemote: ${isRemote}:`, data);
});

// Put an item (saved locally in IndexedDB and synced to server)
await todos.put("task-1", {
  title: "Build awesome app",
  completed: false
});

// Read an item
const task = await todos.get("task-1");

// Read all items
const allTasks = await todos.getAll();

// Delete an item
await todos.delete("task-1");
```

---

## Architecture & Subpaths

- **`beameddb/client`**:
  - `BeamedClientDB`: Main database client.
  - `Table`: Typed table wrapper around IndexedDB object stores.
  - `BeamedSyncClient`: Real-time WebSocket sync manager.
  - `IDBManager`: IndexedDB layer with outbox and metadata stores.
- **`beameddb/server`**:
  - `BeamedServer`: Unified HTTP and WebSocket server.
  - `AuthManager`: User registration, credential verification, and token generation.
  - `SyncHub`: WebSocket connection manager with user-level change routing and broadcasting.
  - `FileStorageAdapter`: Persists data per user in subdirectories (`<baseDir>/<userId>/stores/`).
  - `MemoryStorageAdapter`: In-memory storage adapter.
  - `StorageAdapter`: Pluggable storage adapter interface.
- **`beameddb/shared`**:
  - Shared types (`ChangeRecord`, `StoredRecord`, `ClientMessage`, `ServerMessage`).
  - Clock utilities (`shouldOverwrite`, `generateClientId`).

---

## Running Tests & Building

```bash
# Run unit and end-to-end tests
npm test

# Typecheck
npm run typecheck

# Build bundle
npm run build
```

## License

MIT
