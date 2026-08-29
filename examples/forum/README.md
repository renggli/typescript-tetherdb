# TetherDB Forum Example

A real-time, offline-first collaborative discussion board demonstrating unified recursive post hierarchies, server-enforced permissions, declarative secondary indexes, and multi-user voting with TetherDB.

## Features

- **📱 Offline-First & Local-First**: Discussions, votes, and replies persist instantly to local IndexedDB for zero-latency UI interactions and background sync.
- **🔄 Real-Time Two-Way Sync**: Live WebSocket synchronization automatically pushes new posts, replies, and vote updates to all connected users.
- **🌳 Unified Recursive Post Architecture**: Posts and replies share a single `posts` table using `parentId` references, supporting arbitrary-depth nested discussion threads with a single declarative secondary index `postsTable.index('parentId')`.
- **🔐 Server-Side Table Permissions**: CRUD security rules (`update: Owner`, `delete: Owner`, `create: Authenticated`, `read: Everybody`) are strictly enforced by the server backend.
- **👍 Universal Voting System**: Upvoting and downvoting on posts and nested comments with single-vote uniqueness enforced per user per target.
- **⚡ Declarative Secondary Indexes**:
  - `postsTable.index<string>('community')` — queries top-level posts by community channel.
  - `postsTable.index<string>('parentId')` — reactive lookup and live subscriptions for nested child replies.
  - `votesTable.index<string>('targetId')` — fast retrieval and live score calculation.
- **👤 Multi-Persona Simulation**: Quickly switch between pre-seeded users (`alice`, `bob`, `charlie`) or register new accounts to simulate multi-user collaboration in real time across tabs.
- **⚡ Embedded Vite Backend**: Zero-config backend sync and filesystem storage ([`FileStorage`](../../src/server/storage/file/index.ts)) served directly via `tetherPlugin` in [`vite.config.ts`](vite.config.ts).

## Data Model & Architecture

The forum uses three tables backed by per-user filesystem storage ([`FileStorage`](../../src/server/storage/file/index.ts)):

- **`communities`** ([`src/client.ts`](src/client.ts)): Discussion channels with public read and restricted write permissions, pre-seeded from [`seed.ts`](seed.ts).
- **`posts`** ([`src/client.ts`](src/client.ts)): Unified root threads and nested comments/replies with owner-only mutation permissions.
- **`votes`** ([`src/client.ts`](src/client.ts)): User vote records with owner-only mutation permissions.

See [`seed.ts`](seed.ts) for sample seed data and pre-configured test user accounts.

## Vite Integration

The example uses `tetherPlugin` from `tetherdb/vite` to embed `FileStorage` persistence in `./data`, pre-seed communities and posts, and serve frontend assets and sync over port `3001`. See the complete configuration in [`vite.config.ts`](vite.config.ts).

## Running the Example

From the repository root:

```bash
npm run example:forum
```

Or from within the `examples/forum` directory:

```bash
npm run dev
```

Open **<http://localhost:3001>** in your browser.

## Testing Collaboration

1. Open **<http://localhost:3001>** in multiple browser tabs or windows.
2. Sign in as `alice` in one tab and `bob` or `charlie` in another using the quick sign-in buttons (default password: `password123`).
3. Publish a new post or reply to an existing thread; observe real-time updates and score changes across all tabs.
4. Try editing or deleting posts to verify that only the owner of each post has permission to modify it.
5. Go offline to test offline drafting and automatic sync catch-up when reconnecting.
