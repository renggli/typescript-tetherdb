# Changelog

All notable changes to this project will be documented in this file.

## [0.2.0] - 2026-09-02

### Client & Reactive Querying (`tetherdb/client`)

- **Multi-Tab Synchronization & Leader Election**: Added cross-tab coordination using Web Locks API for uncontested outbox flush leader election and BroadcastChannel for instant real-time UI re-rendering and auth state synchronization.
- **Declarative Secondary Indexes**: Added first-class `Index` API on `Table` (`table.index(...)`) with support for nested paths, compound keys, and array `multiEntry` indexing.
- **Range Queries & Pagination**: Added `IndexRange` helper (`between`, `greaterThan`, `lessThan`, `only`, `bound`) with direction and limit/offset pagination.
- **Reactive Index Subscriptions**: Added live filtered query subscriptions (`index.subscribe(...)`) that react to local mutations and remote WebSocket broadcasts.

### Server Architecture & Security (`tetherdb/server`)

- **Unified Storage & Table Sharing**: Refactored storage architecture from legacy multi-app isolation to a unified storage schema supporting multi-tenant isolation alongside shared tables (`user-private`, `public-read`, `public-read-write`, `shared`).
- **Server-Side Permissions**: Enforced fine-grained CRUD permissions (`Permission.Owner`, `Permission.Authenticated`, `Permission.Everybody`) with explicit record ownership validation on all table operations.
- **Real-Time Broadcast Authorization**: Added author attribution and record-level authorization filtering on live WebSocket change broadcasts.
- **Security Hardening & Rate Limiting**: Added IP-based and account-targeted connection rate limiting, progressive authentication backoff, maximum frame payload size enforcement (1MB), incoming message queue bounding, and password claim validation.
- **Admin Connection Tokens**: Added self-contained base64url admin connection tokens for managing local and in-memory/remote servers.
- **Process Locking & Storage Protection**: Hardened lockfile acquisition (`server.lock`) with TOCTOU race prevention, embedded admin secrets for CLI administration, and active server lock checks on offline storage mutations.

### Vite Integration & Middleware (`tetherdb/vite`)

- **Vite Plugin**: Added `tetherPlugin` for zero-config embedded WebSocket sync, REST auth endpoints, table pre-declaration, user seeding, and graceful server teardown directly inside Vite dev and preview servers.
- **Connect & Express Middleware**: Added `TetherServer.prototype.createMiddleware()` and non-intrusive HTTP server attachment (`attach()`).

### CLI & Administration (`tetherdb/cli`)

- **Table & Schema Management**: Added commands to list, inspect, create, update, and remove tables with custom permissions and quotas (`tables add`, `tables show`, `tables update`, `tables rm`).
- **User & Record Management**: Added CLI commands for managing user accounts (`users add`, `users mv`, `users rm`) and inspecting/mutating table records (`records list`, `records put`, `records rm`).
- **Storage Maintenance & Compaction**: Added WAL checkpointing, vacuuming, and changelog pruning (`maintenance checkpoint`, `maintenance vacuum`, `maintenance prune`).
- **Schema Migration**: Added `migrate` command to convert legacy multi-app database directories to the unified storage schema.
- **Server Stop Command**: Added `stop` command to shut down running servers via lockfile or admin token.

### Example Applications

- **Collaborative Editor** ([`examples/editor/`](examples/editor)): Real-time collaborative markdown editor with multi-user presence cursors and line-based sync backed by `MemoryStorage`.
- **Discussion Forum** ([`examples/forum/`](examples/forum)): Reddit-style community discussion board with recursive nested comments, voting, and server-enforced permissions backed by `FileStorage`.
- **Collaborative Todo** ([`examples/todo/`](examples/todo)): Updated offline-first task list with declarative status filtering, multi-tab sync, and live event stream backed by `SqliteStorage`.

### Documentation & Deployment

- Added reverse proxy configurations for **Apache HTTP Server (`httpd`)**, **Nginx**, and **Caddy** with WebSocket tunneling (`mod_proxy_wstunnel`).
- Added security guidance clarifying endpoint exposure (public WebSocket sync vs. private management routes).

## [0.1.0] - 2026-08-20

- Initial release.
- Offline-first IndexedDB client with real-time two-way WebSocket sync (`tetherdb/client`).
- Server with SQLite, filesystem, and in-memory storage backends (`tetherdb/server`).
- CLI tool for server management and maintenance (`tetherdb/cli`).
