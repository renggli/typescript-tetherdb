# TetherDB Collaborative Editor Example

A real-time, zero-sign-in collaborative markdown editor demonstrating multi-user presence, remote cursors, and live document synchronization powered by TetherDB.

## Features

- **Zero Sign-In & Public Permissions**: Unauthenticated guests join immediately with a random name and vibrant color palette. Tables are configured with `Permission.Everybody` for public read and write access.
- **Live Presence & Multi-Cursors**: Real-time cursor positions, text selection ranges, and collaborator status are synchronized across all connected clients via an active `presence` table.
- **Line-Based Collaborative Document Sync**: The document is structured as ordered lines in a `document` table. Edits, line inserts, and deletions sync instantly across participants without clobbering other lines.
- **Live Markdown Preview**: Split-pane view with real-time rendered HTML preview that auto-updates as users collaborate.
- **Embedded Vite Backend**: Zero-config backend sync and in-memory storage served directly via `tetherPlugin` in `vite.config.ts`.

## Running the Example

From the repository root:

```bash
npm run example:editor
```

Or from within the `examples/editor` directory:

```bash
npm run dev
```

Open `http://localhost:3004` in your browser across multiple windows or tabs to see real-time collaborative editing, live remote cursors, and presence sync in action.
