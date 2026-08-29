# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-08-29

### Client & Reactive Querying (`tetherdb/client`)

- **Declarative Secondary Indexes**: Added first-class `Index` API on `Table` (`table.index(...)`) with support for nested paths, compound keys, and array `multiEntry` indexing.
- **Range Queries & Pagination**: Added `IndexRange` helper (`between`, `greaterThan`, `lessThan`, `only`, `bound`) with direction and limit/offset pagination.
- **Reactive Index Subscriptions**: Added live filtered query subscriptions (`index.subscribe(...)`) that react to local mutations and remote WebSocket broadcasts.
- **Batch Operations**: Atomic local writes and tombstone deletes via `table.putAll()` and `table.deleteAll()`.

### Server Architecture & Security (`tetherdb/server`)

- **Unified Storage & Table Sharing**: Refactored storage architecture to support multi-tenant isolation alongside shared tables (`user-private`, `public-read`, `public-read-write`, `shared`).
- **Server-Side Permissions**: Enforced fine-grained CRUD permissions (`Permission.Owner`, `Permission.Authenticated`, `Permission.Everybody`) on all table operations.
- **Security Hardening**: Added connection rate limiting, progressive authentication backoff, and input validation across handshakes and auth streams.
- **Admin Connection Tokens**: Added self-contained base64url admin connection tokens for managing local and in-memory/remote servers.
- **Process Locking & Crash Recovery**: Exclusive server process lockfile management (`server.lock`) with automatic recovery from stale PIDs.

### Vite Integration & Middleware (`tetherdb/vite`)

- **Vite Plugin**: Added `tetherPlugin` for zero-config embedded WebSocket sync, REST auth endpoints, table pre-declaration, and user seeding directly inside Vite dev and preview servers.
- **Connect & Express Middleware**: Added `TetherServer.prototype.createMiddleware()` and non-intrusive HTTP server attachment (`attach()`).

### CLI & Administration (`tetherdb/cli`)

- **Table & Schema Management**: Added commands to list, inspect, create, update, and remove tables with custom permissions and quotas (`tables add`, `tables show`, `tables update`, `tables rm`).
- **User & Record Management**: Added CLI commands for managing user accounts (`users add`, `users rm`) and inspecting/mutating table records (`records list`, `records put`, `records rm`).
- **Storage Maintenance & Compaction**: Added WAL checkpointing, vacuuming, and changelog pruning (`maintenance checkpoint`, `maintenance vacuum`, `maintenance prune`).
- **Schema Migration**: Added `migrate` command to convert legacy multi-app database directories to the unified storage schema.

### Example Applications

- **Collaborative Editor** ([`examples/editor/`](examples/editor)): Real-time collaborative markdown editor with multi-user presence cursors and line-based sync backed by `MemoryStorage`.
- **Discussion Forum** ([`examples/forum/`](examples/forum)): Reddit-style community discussion board with recursive nested comments, voting, and server-enforced permissions backed by `FileStorage`.
- **Collaborative Todo** ([`examples/todo/`](examples/todo)): Offline-first task list with declarative status filtering and live event stream backed by `SqliteStorage`.

### Documentation & Deployment

- Added **Apache HTTP Server (`httpd`)** reverse proxy configuration with WebSocket tunneling (`mod_proxy_wstunnel`).
- Added security guidance clarifying endpoint exposure (public WebSocket sync vs. private management routes).

## [0.1.0] - 2026-08-20

- Initial release.
- Offline-first IndexedDB client with real-time two-way WebSocket sync (`tetherdb/client`).
- Server with SQLite, filesystem, and in-memory storage backends (`tetherdb/server`).
- CLI tool for server management and maintenance (`tetherdb/cli`).
