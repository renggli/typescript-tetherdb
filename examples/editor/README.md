# TetherDB Collaborative Editor Example

A real-time, zero-sign-in collaborative markdown editor demonstrating multi-user presence, remote cursors, and line-based collaborative document synchronization powered by TetherDB.

## Features

- **📱 Offline-First & Local-First**: Keystrokes apply immediately to browser IndexedDB with zero input latency and queue in an atomic outbox for background synchronization.
- **🔄 Real-Time Two-Way Sync**: Fast WebSocket synchronization broadcasts line mutations, selections, and cursor movements across all active tabs and devices.
- **👥 Live Presence & Multi-Cursors**: Real-time cursor positions, text selection ranges, and active collaborator status are synchronized across all connected participants via a reactive `presence` table.
- **📝 Line-Based Collaborative Document Sync**: The document is structured as ordered lines in a `document` table. Edits, line inserts, and deletions sync instantly across participants without clobbering other lines.
- **👁️ Live Markdown Preview**: Split-pane view with real-time rendered HTML preview that auto-updates as users collaborate.
- **⚡ Embedded Vite Backend**: Zero-config backend sync with in-memory storage ([`MemoryStorage`](../../src/server/storage/memory/index.ts)) served directly via `tetherPlugin` in [`vite.config.ts`](vite.config.ts).

## Data Model & Architecture

The collaborative editor defines two tables served with ephemeral in-memory storage:

- **`document`** ([`src/client.ts`](src/client.ts)): Stores each line of the collaborative document with its ordering and text content, seeded directly from this [`README.md`](README.md) in [`vite.config.ts`](vite.config.ts).
- **`presence`** ([`src/client.ts`](src/client.ts)): Synchronizes active collaborator identities, assigned colors, cursor coordinates, and text selection ranges.

Both tables are configured with `PUBLIC_READ_WRITE_PERMISSIONS` in [`vite.config.ts`](vite.config.ts) for seamless guest collaboration without requiring authentication.

## Vite Integration

The example uses `tetherPlugin` from `tetherdb/vite` to embed `MemoryStorage`, pre-seed initial document lines directly from [`README.md`](README.md), and serve frontend assets and sync over port `3000`. See the full setup in [`vite.config.ts`](vite.config.ts).

## Running the Example

From the repository root:

```bash
npm run example:editor
```

Or from within the `examples/editor` directory:

```bash
npm run dev
```

Open **<http://localhost:3000>** in your browser.

## Testing Collaboration

1. Open **<http://localhost:3000>** in two or more browser windows or tabs side-by-side.
2. Each participant is assigned a unique name and color in the header.
3. Type or navigate in one window to observe live cursor indicators, selection highlighting, and line updates in the other tabs in real time.
4. Toggle offline mode in DevTools Network tab to test local-first editing and automatic sync reconciliation upon reconnecting.
