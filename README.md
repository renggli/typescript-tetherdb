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
[Example App](#example-application)

## Features

- **📱 Offline-First & Local-First**: Mutations apply immediately to browser IndexedDB with zero latency and queue in an atomic outbox for background synchronization.
- **🔄 Real-Time Two-Way Sync**: Fast, bi-directional WebSocket sync with delta diff catch-up on reconnect, adaptive full snapshots, and automatic live broadcast to active sessions.
- **⚖️ Deterministic Conflict Resolution**: Last-Write-Wins (LWW) conflict handling powered by monotonically increasing logical clocks and deterministic tie-breaking.
- **🏢 Multi-Tenant & Multi-App**: Host multiple independent web applications on a single domain and server instance. Data and WebSocket streams are strictly isolated by `appId` and user account.
- **🚀 Seamless Offline-to-Cloud Onboarding**: Start using the local database immediately without an account; attach live cloud sync on demand with a single `client.login()` or `client.register()` call.
- **🗄️ Pluggable Server Storage**: Built-in persistence engines for SQLite (`SqliteStorage`), sharded filesystem directories (`FileStorage`), and ephemeral testing (`MemoryStorage`).
- **🔐 Built-in Authentication**: Password hashing using scrypt with salt and HMAC-signed session tokens with automatic session persistence and recovery.
- **⚡ Batch-by-Default Performance**: High-throughput atomic mutations (`putAll`, `deleteAll`, `getAll`) and coalesced WebSocket frame transmission.

## Installation

```bash
npm install tetherdb
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
const client = new TetherClient('my-todo-app', {
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

### 3. Attach Live Cloud Sync & Authentication

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
```

## CLI & Server Administration

TetherDB includes a full CLI suite for running servers and managing databases:

```bash
# Start standalone server with SQLite persistence
npx tetherdb --sqlite=./data --port=8080

# Start with filesystem storage
npx tetherdb --file=./data --port=8080

# Manage apps and users
npx tetherdb apps list --sqlite=./data
npx tetherdb users create --sqlite=./data --app=my-todo-app --user=alice --password=secret

# Run database maintenance & compaction
npx tetherdb maintenance checkpoint --sqlite=./data
npx tetherdb maintenance vacuum --sqlite=./data
npx tetherdb maintenance prune --sqlite=./data --keep=1000
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

When deploying to production, place TetherDB behind a reverse proxy (such as **Caddy** or **Nginx**) for SSL/TLS termination and WebSocket proxying:

### Caddy (`Caddyfile`)

```caddy
api.example.com {
    reverse_proxy localhost:8080
}
```

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name api.example.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # WebSocket headers
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Forwarded headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

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
# Format & lint check
npm run format
npm run check

# Run unit and integration tests
npm test

# Type check
npm run typecheck

# Build bundle & type definitions
npm run build
```
