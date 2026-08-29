# TetherDB Todo Example

A real-time, local-first Todo application demonstrating two-way synchronization, offline persistence, declarative secondary indexes, and user authentication with TetherDB.

## Features

- **📱 Offline-First & Local-First**: Mutations apply immediately to browser IndexedDB with zero latency and persist offline across sessions.
- **🔄 Real-Time Two-Way Sync**: Live WebSocket synchronization streams mutations across active clients and devices in real time with automatic reconnect backoff.
- **⚖️ Deterministic Conflict Resolution**: Last-Write-Wins (LWW) conflict handling powered by monotonically increasing logical clocks and deterministic client tie-breaking.
- **⚡ Declarative Secondary Indexes**: Fast status filtering (`todosTable.index('status')`), active counts, and primary key lookups.
- **🔐 User Accounts & Data Isolation**: Start as an offline guest with local storage, then attach cloud sync on demand with user registration or login (`client.login()`, `client.register()`).
- **📊 Reactive Event Stream**: On-screen live event stream distinguishing local IndexedDB writes from remote WebSocket sync broadcasts.
- **⚡ Embedded Vite Backend**: Zero-config backend sync and persistent SQLite storage ([`SqliteStorage`](../../src/server/storage/sqlite/index.ts)) served directly via `tetherPlugin` in [`vite.config.ts`](vite.config.ts).

## Data Model & Architecture

The todo app uses a single typed table backed by persistent SQLite storage ([`SqliteStorage`](../../src/server/storage/sqlite/index.ts)):

- **`todos`** ([`src/client.ts`](src/client.ts)): Stores task items with `title` and `status` (`active` / `completed`).

A declarative secondary index on `status` enables fast querying and reactive filtered views for active and completed tasks.

## Vite Integration

The example uses `tetherPlugin` from `tetherdb/vite` to embed `SqliteStorage` persistence in `./data`, pre-provision the table schema, and serve both frontend assets and backend sync over port `3002`. See the complete configuration in [`vite.config.ts`](vite.config.ts).

## Running the Example

From the repository root:

```bash
npm run example:todo
```

Or from within the `examples/todo` directory:

```bash
npm run dev
```

Open **http://localhost:3002** in your browser.

## Testing Collaboration

1. Open **http://localhost:3002** across multiple browser windows or tabs.
2. Start adding tasks as an offline guest with local IndexedDB storage.
3. Register a new user account (or sign in) to attach live WebSocket sync and stream changes across tabs in real time.
4. Sign out to test data isolation (signing out clears the synced list and returns to local guest mode).
5. Toggle offline mode in DevTools Network tab to test local-first task creation and automatic synchronization reconciliation upon reconnection.
