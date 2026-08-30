# ⚡ TetherDB

**Lightweight, local-first TypeScript database with reactive IndexedDB storage and real-time two-way WebSocket sync.**

[![NPM Version](https://img.shields.io/npm/v/tetherdb.svg?style=flat-square&color=blue)](https://www.npmjs.com/package/tetherdb)
[![Build Status](https://img.shields.io/github/actions/workflow/status/renggli/typescript-tetherdb/ci.yml?branch=main&style=flat-square)](https://github.com/renggli/typescript-tetherdb/actions)
[![Code Coverage](https://img.shields.io/codecov/c/github/renggli/typescript-tetherdb?style=flat-square)](https://codecov.io/gh/renggli/typescript-tetherdb)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-blue?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

*Open-source under the [MIT License](LICENSE).*

[Features](#features) •
[Installation](#installation) •
[Quick Start](#quick-start) •
[Framework Integration](#framework-integration) •
[CLI & Server](#cli--server-administration) •
[Production Deployment](#production-deployment) •
[Example Applications](#example-applications) •
[Changelog](CHANGELOG.md)

## Features

- **📱 Offline-First & Local-First**: Mutations apply immediately to browser IndexedDB with zero latency and queue in an atomic outbox for background synchronization.
- **🔄 Real-Time Two-Way Sync**: Fast, bi-directional WebSocket sync with delta diff catch-up on reconnect, adaptive full snapshots, and automatic live broadcast to active sessions.
- **⚖️ Deterministic Conflict Resolution**: Last-Write-Wins (LWW) conflict handling powered by monotonically increasing logical clocks and deterministic tie-breaking.
- **🏢 Multi-Tenant & Table Sharing**: Isolate data strictly per-user or share tables globally or across teams with fine-grained access modes (`user-private`, `public-read`, `public-read-write`, `shared`).
- **🚀 Seamless Offline-to-Cloud Onboarding**: Start using the local database immediately without an account; attach live cloud sync on demand with a single `client.login()` or `client.register()` call.
- **🗄️ Pluggable Server Storage**: Built-in persistence engines for SQLite (`SqliteStorage`), sharded filesystem directories (`FileStorage`), and ephemeral testing (`MemoryStorage`).
- **🔐 Built-in Authentication**: Password hashing using scrypt with salt and HMAC-signed session tokens with automatic session persistence and recovery.
- **⚡ Batch-by-Default Performance**: High-throughput atomic mutations (`putAll`, `deleteAll`, `getAll`) and coalesced WebSocket frame transmission.

## Installation

Install from npm:

```bash
npm install tetherdb
```

Or install directly from GitHub:

```bash
npm install github:renggli/typescript-tetherdb
```

## Quick Start

### 1. Launch a Server (Zero-Config)

You can launch a standalone TetherDB server in seconds using the CLI:

```bash
# Start server with persistent SQLite storage on port 8080
npx tetherdb --sqlite=./data --port=8080
```

Or embed it programmatically in your Node.js backend:

```typescript
import { SqliteStorage, startServer } from 'tetherdb/server';

const running = await startServer({
  port: 8080,
  storage: new SqliteStorage({ baseDir: './data' }),
});

console.log(`TetherDB server listening on http://${running.host}:${running.port}`);
```

### 2. Client Setup: Instant Local-First Storage

TetherDB works out of the box in the browser. Writes are instant and persist offline:

```typescript
import { TetherClient } from 'tetherdb/client';

interface Todo {
  title: string;
  completed: boolean;
}

// 1. Initialize client with server endpoint
const client = new TetherClient('todo-app', {
  url: 'http://localhost:8080',
});

// 2. Obtain a typed table
const todos = client.table<Todo>('todos');

// 3. React to local and remote data changes
const unsubscribe = todos.onChange.register((events) => {
  for (const { op, id, data, isRemote } of events) {
    console.log(`Table event [${op}] on ${id} (remote: ${isRemote}):`, data);
  }
});

// 4. Instant local writes (offline-ready)
await todos.put('task-1', {
  title: 'Try TetherDB',
  completed: false,
});

// Batch operations execute in a single atomic transaction
await todos.putAll([
  { id: 'task-2', data: { title: 'Add offline support', completed: true } },
  { id: 'task-3', data: { title: 'Sync with cloud', completed: false } },
]);

// Read data
const item = await todos.get('task-1');
const allItems = await todos.getAll();
```

### 3. Declarative Indexes & Querying

Define type-safe indexes on tables declaratively and query data with full range, pagination, and reactive subscription support:

```typescript
import { IndexDirection, IndexRange, TetherClient } from 'tetherdb/client';

interface User {
  userName: string;
  email: string;
  age: number;
  tags: string[];
  department: string;
  role: string;
}

const client = new TetherClient('my-app');

// 1. Acquire table reference
const users = client.table<User>('users');

// 2. Define or acquire indexes directly on the table
const email = users.index<string>('email', { unique: true });
const age = users.index<number>('age');
const tags = users.index<string>('tags', { multiEntry: true });
const deptRole = users.index<[string, string]>(['department', 'role']);

// 3. Query via typed index accessors
const user = await email.get('alice@example.com');
const adults = await age.getAll(IndexRange.greaterThan(18, true));
const twenties = await age.getAll(IndexRange.between(20, 29));
const seniorsInEng = await deptRole.getAll(['eng', 'senior']);
const devCount = await tags.count('typescript');

// 4. Pagination & Sorting
const topOldest = await age.getAll(undefined, {
  direction: IndexDirection.Prev,
  limit: 10,
  offset: 0,
});

// 5. Reactive index subscriptions
const unsubscribe = tags.subscribe('typescript', (matchingUsers) => {
  console.log('TypeScript developers updated:', matchingUsers);
});
```

### 4. Attach Live Cloud Sync & Authentication

Connect your local data to the cloud whenever the user registers or signs in:

```typescript
// Register or login to initiate real-time synchronization
await client.register({
  userName: 'alice',
  password: 'secure-password',
  remember: true, // Persists session token across browser reloads
});

// Monitor live connection and sync status
client.onSyncStatusChange.register((status) => {
  // 'disconnected' | 'connecting' | 'connected' | 'syncing' | 'synced'
  console.log('Sync status:', status);
});
```

## Framework Integration

### Vite Plugin (Zero-Config Development)

Embed TetherDB sync and authentication directly inside your Vite dev and preview servers with `tetherdb/vite`:

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { SqliteStorage } from 'tetherdb/server';
import { tetherPlugin } from 'tetherdb/vite';

export default defineConfig({
  plugins: [
    tetherPlugin({
      // Optional persistent storage (defaults to in-memory)
      storage: new SqliteStorage({ baseDir: './data' }),
      // Pre-declare tables and access settings
      tables: ['todos'],
      // Pre-provision default demo accounts
      users: [{ userName: 'demo', password: 'password123' }],
    }),
  ],
});
```

Now running `vite` serves frontend assets (HMR), observability endpoints, and real-time WebSocket sync & auth (`/tether`) all on the same dev port with zero CORS configuration!

### Connect & Express Middleware

Mount TetherDB endpoints into an existing Express or Node.js HTTP application:

```typescript
import express from 'express';
import { TetherServer } from 'tetherdb/server';

const app = express();
const tetherServer = new TetherServer();

// Mount observability and admin REST middleware
app.use(tetherServer.createMiddleware());

const server = app.listen(8080);

// Attach WebSocket sync & auth handler
tetherServer.attach(server);
```

### React Hook Example

Bind any TetherDB table to component state with automatic real-time updates:

```typescript
import { useEffect, useState } from 'react';
import type { Index, IndexQueryOptions, Table } from 'tetherdb/client';

export function useTable<T>(table: Table<T>): T[] {
  const [items, setItems] = useState<T[]>([]);

  useEffect(() => {
    // 1. Initial local load
    table.getAll().then(setItems);

    // 2. Subscribe to live changes (local writes & remote sync broadcasts)
    const unsubscribe = table.onChange.register(() => {
      table.getAll().then(setItems);
    });

    return unsubscribe;
  }, [table]);

  return items;
}

export function useIndex<T, K extends IDBValidKey = IDBValidKey>(
  index: Index<T, K>,
  query?: K | IDBKeyRange,
  options?: IndexQueryOptions,
): T[] {
  const [items, setItems] = useState<T[]>([]);

  useEffect(() => {
    return index.subscribe(query, setItems, options);
  }, [index, query, options?.limit, options?.offset, options?.direction]);

  return items;
}
```

## CLI & Server Administration

TetherDB includes a comprehensive command-line interface for managing storage backends, table schemas, permissions, records, user accounts, and running maintenance tasks offline or against a running server.

### Global Options

All CLI commands support target backend flags:

- `--sqlite[=<dir>]` — Target persistent SQLite database (default directory: `.data`).
- `--file[=<dir>]` — Target filesystem JSON storage (default directory: `.data`).
- `--memory[=<token>]` — Target in-memory storage (pass admin token for remote servers).
- `-p, --port <number>` — Server port to bind or connect to (default: `8080`).
- `-H, --host <string>` — Host interface to bind (default: `0.0.0.0`).
- `-t, --token <token>` — Self-contained admin connection token.

### Server Lifecycle

```bash
# Start standalone server with SQLite persistence
npx tetherdb serve --sqlite=./data --port=8080

# Start server in background with custom host
npx tetherdb serve --file=./data --host=127.0.0.1 --port=9000

# Inspect server status, database size, table count, and user count
npx tetherdb status --sqlite=./data

# Gracefully stop a running server via its lockfile or admin token
npx tetherdb stop --sqlite=./data
```

### Table & Schema Management

Create and configure tables with predefined permission presets (`user-private`, `public-read`, `public-read-write`, `shared`) or fine-grained limits:

```bash
# List all tables
npx tetherdb tables --sqlite=./data

# Create a table with specific permission mode
npx tetherdb tables add todos --mode=user-private --sqlite=./data
npx tetherdb tables add posts --mode=public-read --sqlite=./data
npx tetherdb tables add comments --mode=shared --sqlite=./data

# Create a table with quota limits
npx tetherdb tables add logs --max-records=50000 --max-size=10240 --sqlite=./data

# Show table schema, settings, and permissions
npx tetherdb tables show todos --sqlite=./data

# Update table permissions or reset to default
npx tetherdb tables update todos --mode=public-read --sqlite=./data
npx tetherdb tables update todos --reset --sqlite=./data

# Delete a table and all its data
npx tetherdb tables rm old_table --sqlite=./data
```

### User Account Administration

```bash
# List registered user accounts
npx tetherdb users --sqlite=./data

# Register a new user account
npx tetherdb users add alice securepassword123 --sqlite=./data

# Rename a user account
npx tetherdb users mv alice alicia --sqlite=./data

# Delete a user account and purge user data partitions
npx tetherdb users rm alicia --sqlite=./data
```

### Record Inspection & Mutations

```bash
# List records in a table
npx tetherdb records list todos --sqlite=./data

# List records belonging to a specific user
npx tetherdb records list todos --user=alice --sqlite=./data

# Put or update a record directly with JSON data
npx tetherdb records put todos task-1 '{"title":"Buy milk","completed":false}' --sqlite=./data

# Delete a record
npx tetherdb records rm todos task-1 --sqlite=./data
```

### Storage Maintenance & Compaction

Keep SQLite and filesystem databases compact and fast with built-in maintenance commands:

```bash
# Truncate SQLite Write-Ahead Log (WAL) files
npx tetherdb maintenance checkpoint --sqlite=./data

# Reclaim disk space, defragment, and rebuild database files
npx tetherdb maintenance vacuum --sqlite=./data

# Prune historical changelogs older than the specified retention threshold
npx tetherdb maintenance prune 1000 --sqlite=./data

# Migrate legacy multi-app database to the unified storage schema
npx tetherdb migrate --sqlite=./data
```

## HTTP & WebSocket Endpoints

| Method | Endpoint | Description | Access Level |
| :--- | :--- | :--- | :--- |
| `WS` | `/tether` | Bi-directional WebSocket synchronization and auth stream | **Public** (Client App) |
| `GET` | `/health` | Server uptime and liveness probe | Public / Internal |
| `GET` | `/ready` | Storage backend readiness check | Internal Management |
| `GET` | `/metrics` | Connected clients, table counts, memory metrics | Internal Management |
| `*` | `/admin/*` | REST API for tables, users, records, and maintenance | Admin (Bearer Token) |

> [!IMPORTANT]
> **Security Notice — Expose Only the WebSocket Port / Route (`/tether`)**:
> TetherDB clients communicate and synchronize exclusively over the real-time WebSocket connection (`/tether`). All other endpoints (`/admin/*`, `/metrics`, `/ready`) are private management and observability interfaces intended strictly for server operators.
>
> In production environments, configure your reverse proxy or firewall to expose **only** the WebSocket path (`/tether`) to public client traffic. Keep administrative and metrics routes private and inaccessible from untrusted networks.

## Production Deployment

### Storage Engines

TetherDB supports pluggable server storage backends:

| Engine | CLI Flag | Pros | Cons |
| :--- | :--- | :--- | :--- |
| **SQLite** (`SqliteStorage`) | `--sqlite=<dir>` | • High throughput & ACID safety<br>• WAL mode concurrency<br>• Built-in compaction (`vacuum`, `prune`) | • Single-node filesystem binding |
| **Filesystem** (`FileStorage`) | `--file=<dir>` | • Human-readable JSON structure<br>• Zero binary dependencies<br>• Direct inspection & simple backup | • I/O overhead on large tables<br>• Lower concurrent write throughput |
| **In-Memory** (`MemoryStorage`) | `--memory` | • Zero disk I/O, ultra-fast<br>• Zero configuration | • Ephemeral (data lost on restart) |

#### When to Use Which

- **SQLite (`--sqlite`) — Best for Production (Recommended)**: Ideal for multi-user and high-concurrency apps requiring fast transactional persistence and operational maintenance tools (`vacuum`, `checkpoint`, `prune`).
- **Filesystem (`--file`) — Best for Lightweight / Embedded**: Ideal for low-traffic apps, resource-constrained environments, or setups where direct inspection and editing of JSON files is desired.
- **In-Memory (`--memory`) — Best for Testing & CI/CD**: Ideal for automated unit/integration test suites, ephemeral pipelines, and rapid local prototyping.

### Reverse Proxy & SSL Termination

In production, run TetherDB behind a reverse proxy (Apache, Nginx, or Caddy) to terminate SSL/TLS and forward WebSocket connections to your local TetherDB daemon.

#### Apache HTTP Server (`httpd`)

Ensure `mod_proxy`, `mod_proxy_http`, `mod_proxy_wstunnel`, and `mod_rewrite` are enabled:

```apache
<VirtualHost *:443>
  ServerName api.example.com

  SSLEngine on
  SSLCertificateFile /path/to/cert.pem
  SSLCertificateKeyFile /path/to/key.pem

  # Forward WebSocket synchronization route
  RewriteEngine On
  RewriteCond %{HTTP:Upgrade} =websocket [NC]
  RewriteRule ^/tether$ ws://127.0.0.1:8080/tether [P,L]

  # Block private administrative endpoints
  <Location "/admin">
    Require all denied
  </Location>
  <Location "/metrics">
    Require all denied
  </Location>
</VirtualHost>
```

#### Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name api.example.com;

  ssl_certificate /path/to/cert.pem;
  ssl_certificate_key /path/to/key.pem;

  # Forward WebSocket synchronization route
  location /tether {
    proxy_pass http://127.0.0.1:8080/tether;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
  }

  # Block private administrative endpoints
  location /admin {
    deny all;
    return 404;
  }
  location /metrics {
    deny all;
    return 404;
  }
}
```

#### Caddy

```caddy
api.example.com {
  # Forward WebSocket synchronization route
  handle /tether* {
    reverse_proxy localhost:8080
  }

  # Block private administrative endpoints
  handle /admin* {
    abort
  }
  handle /metrics* {
    abort
  }
}
```

## Example Applications

Check out the included example applications demonstrating TetherDB features across different server persistence engines:

- **Collaborative Editor** ([`examples/editor/`](examples/editor)): Real-time collaborative markdown editor with multi-user presence, remote cursors, and line-based collaborative document sync powered by in-memory storage (`MemoryStorage`).

  ```bash
  npm run example:editor
  ```

  Open `http://localhost:3000` to test.

- **Discussion Forum** ([`examples/forum/`](examples/forum)): Reddit-style community discussion board with sub-communities, multi-user upvoting/downvoting, recursive threaded comments, server-enforced permissions, and persona switching backed by filesystem storage (`FileStorage`).

  ```bash
  npm run example:forum
  ```

  Open `http://localhost:3001` to test.

- **Collaborative Todo** ([`examples/todo/`](examples/todo)): Local-first task manager with reactive secondary status indexes, active counts, live event stream, and user authentication backed by SQLite persistence (`SqliteStorage`).

  ```bash
  npm run example:todo
  ```

  Open `http://localhost:3002` to test.

## Development & Testing

```bash
# Format code & lint fix 
npm run format
npm run lint

# Type check
npm run typecheck

# Run unit and integration tests
npm test

# Run tests with coverage
npm run test:coverage

# Build bundle & type definitions
npm run build
```
