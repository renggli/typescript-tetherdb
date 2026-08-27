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
[Example App](#example-application) •
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
const client = new TetherClient({
  name: 'todo-app',
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
  username: string;
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
  username: 'alice',
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
      users: [{ username: 'demo', password: 'password123' }],
    }),
  ],
});
```

Now running `vite` serves frontend assets (HMR), REST authentication endpoints (`/auth/login`, `/auth/register`), and real-time WebSocket sync (`/sync`) all on the same dev port with zero CORS configuration!

### Connect & Express Middleware

Mount TetherDB endpoints into an existing Express or Node.js HTTP application:

```typescript
import express from 'express';
import { TetherServer } from 'tetherdb/server';

const app = express();
const tetherServer = new TetherServer();

// Mount authentication and health REST middleware
app.use(tetherServer.createMiddleware());

const server = app.listen(8080);

// Attach WebSocket sync handler
tetherServer.attach(server);
```

### React Hook Example

Bind any TetherDB table to component state with automatic real-time updates:

```typescript
import { useEffect, useState } from 'react';
import type { Table } from 'tetherdb/client';

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

TetherDB includes a full CLI suite for running servers and managing databases:

```bash
# Start standalone server with SQLite persistence
npx tetherdb --sqlite=./data --port=8080

# Start with filesystem storage
npx tetherdb --file=./data --port=8080

# Manage apps, tables, and users
npx tetherdb apps list --sqlite=./data
npx tetherdb apps add todo-app --sqlite=./data
npx tetherdb tables add todo-app todos --sqlite=./data
npx tetherdb users add alice secret --sqlite=./data

# Run database maintenance & compaction
npx tetherdb maintenance checkpoint --sqlite=./data
npx tetherdb maintenance vacuum --sqlite=./data
npx tetherdb maintenance prune todo-app 1000 --sqlite=./data
```

## HTTP & WebSocket Endpoints

| Method | Endpoint | Description | Authentication |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Server uptime and health probe | Public |
| `GET` | `/ready` | Storage backend readiness check | Public |
| `GET` | `/metrics` | Connected clients and application metrics | Public |
| `POST` | `/auth/register` | Create a new user account | Public |
| `POST` | `/auth/login` | Log in and receive a signed session token | Public |
| `WS` | `/sync` | Bi-directional WebSocket synchronization stream | Token handshake |

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

For production, run TetherDB behind a reverse proxy (such as Caddy or Nginx) to handle SSL/TLS and proxy WebSocket connections:

#### Caddy

```caddy
api.example.com {
  reverse_proxy localhost:8080
}
```

#### Nginx

```nginx
server {
  listen 443 ssl http2;
  server_name api.example.com;

  ssl_certificate /path/to/cert.pem;
  ssl_certificate_key /path/to/key.pem;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_buffering off;
  }
}
```

## Example Application

Check out the included real-time multi-client collaborative Todo app in [`examples/todo/`](examples/todo):

```bash
# Build packages and start example app
npm run build
npm run example:todo
```

Open `http://localhost:3000` in multiple browser windows or simulate offline mode in DevTools to see seamless local-first persistence and instant background synchronization.

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
