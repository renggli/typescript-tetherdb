# TetherDB Forum Example (TetherForum)

A real-time, offline-first collaborative discussion board and community forum.

## Features

- **Unified Recursive Post Architecture**: Posts and replies/comments share a single `posts` table using `parentId` relationships, allowing arbitrary-depth nested discussion threads with a single declarative secondary index `postsTable.index('parentId')`.
- **Server-Side Table Permissions**: All CRUD rules (`update: Owner`, `delete: Owner`, `create: Authenticated`) are enforced by the server backend.
- **Universal Voting System**: Votes work on all posts and nested replies via the `votes` table. Users can cast upvotes/downvotes or remove their vote, with single-vote uniqueness enforced per user per post.
- **Declarative Secondary Indexes**:
  - `postsTable.index<string>('community')` — queries top-level posts by community.
  - `postsTable.index<string>('parentId')` — reactive lookup and live subscriptions for nested child replies.
  - `votesTable.index<string>('targetId')` — fast retrieval and live score calculation for posts and replies.
- **Multi-Persona Simulation**: Quickly switch between pre-seeded users (`demo`, `alice`, `bob`, `charlie`, `admin`) to test multi-user collaboration in real time across multiple tabs.
- **Embedded Vite Backend**: Zero-config backend sync and SQLite persistence served directly via `tetherPlugin` in `vite.config.ts`.
- **Live Event Stream**: On-screen activity log distinguishing local IndexedDB writes from remote WebSocket sync broadcasts.

## Running the Example

From the repository root:

```bash
npm run example:forum
```

Or from within the `examples/forum` directory:

```bash
npm install
npm run dev
```

Open `http://localhost:3002` in your browser. Open multiple windows or tabs to see live collaborative voting and comments in action!
