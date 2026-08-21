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
- **Modern Subpath Exports**: Import cleanly via `tetherdb` (client facade), `tetherdb/client`, `tetherdb/server`, and `tetherdb/cli`.

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

Or programmatically in TypeScript with custom CORS and logging:

```typescript
import { SqliteStorage, startServer } from 'tetherdb/server';

const running = await startServer({
  port: 8080,
  storage: new SqliteStorage({ baseDir: './data' }),
  trustProxy: true, // Enable when running behind Nginx, Caddy, or Cloudflare
  cors: {
    origin: ['https://myapp.com', 'https://staging.myapp.com'],
    credentials: true,
  },
  logger: console, // Or custom logger (Pino, Winston)
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

// 1. Initialize local client with unified URL connection
const client = new TetherClient('todo-app', {
  url: 'http://localhost:8080', // or 'https://api.example.com/db'
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

### 3. Framework Integration (e.g. React)

TetherDB tables subscribe seamlessly to UI state updates using standard hooks:

```typescript
import { useEffect, useState } from 'react';
import type { Table } from 'tetherdb/client';

export function useTableData<T>(table: Table<T>): T[] {
  const [items, setItems] = useState<T[]>([]);

  useEffect(() => {
    // Initial fetch
    table.getAll().then(setItems);

    // Live update subscription
    const unsubscribe = table.onChange.register(() => {
      table.getAll().then(setItems);
    });

    return unsubscribe;
  }, [table]);

  return items;
}
```

## Production Deployment & Reverse Proxy

When deploying in production, run TetherDB behind a reverse proxy (like **Caddy** or **Nginx**) to handle SSL/TLS termination and WebSocket upgrade headers:

### Caddy Configuration (`Caddyfile`)

```caddy
api.example.com {
    reverse_proxy localhost:8080
}
```

### Nginx Configuration

```nginx
server {
    listen 443 ssl http2;
    server_name api.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # WebSocket Upgrade Headers
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Forwarded Headers for Rate Limiting
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Disable proxy buffering for real-time streaming
        proxy_buffering off;
    }
}
```

## Storage Maintenance & Operations

For SQLite backends, TetherDB provides built-in maintenance routines to manage WAL logs and changelog sizes:

```bash
# Checkpoint WAL logs
npx tetherdb maintenance checkpoint --sqlite=./data

# Vacuum SQLite database files
npx tetherdb maintenance vacuum --sqlite=./data

# Prune changelog history (keeping last 1,000 changes per table)
npx tetherdb maintenance prune --sqlite=./data --keep=1000
```

## HTTP Endpoints

The standard server provides authentication and WebSocket sync endpoints:

| Method | Endpoint | Description | Auth Required |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Server health and uptime check | No |
| `GET` | `/ready` | Storage readiness check | No |
| `GET` | `/metrics` | Connected clients and app metrics | No |
| `POST` | `/auth/register` | Register a new user account | No |
| `POST` | `/auth/login` | Log in and receive signed session token | No |
| `WS` | `/sync` | Two-way WebSocket real-time synchronization | Token handshake in auth message |

---

## Architecture & Subpaths

- **`tetherdb` / `tetherdb/client`**: Reactive local-first client layer providing IndexedDB storage, CRUD tables, authentication state, and automatic WebSocket synchronization.
- **`tetherdb/server`**: Backend server coordinator handling HTTP authentication endpoints, WebSocket sync routing, and pluggable storage engines (memory, file, and SQLite).
- **`tetherdb/cli`**: Command-line administrative interface and runner for launching servers and managing applications, tables, and user accounts.

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
