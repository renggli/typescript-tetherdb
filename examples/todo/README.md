# TetherDB Todo Example

A real-time, local-first Todo application demonstrating two-way synchronization and offline persistence with TetherDB.

The application reads and writes directly to browser IndexedDB for zero-latency local operations, while a background WebSocket connection streams mutations across active clients and devices in real time. When offline, changes queue locally in IndexedDB and reconcile automatically with the server upon reconnection using deterministic Last-Write-Wins conflict resolution.

## Zero-Config Vite Integration

The example uses `tetherPlugin` from `tetherdb/vite` in `vite.config.ts` to embed persistent SQLite storage, pre-provision the schema, and serve both frontend assets and backend sync over the same single dev port (`http://localhost:3000`):

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import { SqliteStorage } from 'tetherdb/server';
import { tetherPlugin } from 'tetherdb/vite';

export default defineConfig({
  plugins: [
    tetherPlugin({
      storage: new SqliteStorage({ baseDir: './data' }),
      apps: [{ appId: 'todo-example', tables: ['todos'] }],
      users: [{ username: 'demo', password: 'password123' }],
    }),
  ],
  server: {
    port: 3000,
  },
});
```

## How to Run

From the repository root:

```bash
npm run example:todo
```

Or from the `examples/todo` directory:

```bash
npm run dev
```

Open **http://localhost:3000** across multiple devices, browsers, or tabs to observe real-time synchronization, user switching, and offline editing.
