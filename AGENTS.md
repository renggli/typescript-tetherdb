# TetherDB — AI Developer Guide & Architecture Map

This document outlines the core architecture, developer rules, TypeScript conventions, and testing guidelines for developing TetherDB.

> [!IMPORTANT]
> **Backward Compatibility Policy**:
>
> - **Must Preserve**: Maintain backward compatibility for all **public APIs** (exported types, classes, methods, and events) and **persistent storage layers** (IndexedDB client schemas, SQLite/File server persistence formats, and database schemas) since the last public release (tagged with git). When evolving schemas or public APIs, ensure seamless migration paths and compatibility.
> - **No Backward Compatibility Needed**: Internal APIs, private helpers, transient in-memory data structures, internal wire message details, and test harnesses do not require backward compatibility. Directly refactor and clean internal code without accumulating cruft or legacy shims.

## 🚨 Developer Rules & Quality Checks

- **Structure & Documentation**: Public APIs, exported types, classes, and functions must be placed at the top of the file and thoroughly documented with JSDoc comments. Methods should be concise, focused, and readable. Avoid unnecessary abbreviations in identifiers.
- **Logical Declaration & Member Ordering**: Order fields, methods, classes, and interfaces meaningfully across all files:
  - **Types & Interfaces**: Place base types and models first, followed by configuration options, and then result/status types. Order fields logically: identifiers/discriminators → payloads → sequence/timestamps → ownership → configuration/limits.
  - **Classes**: Order members from top to bottom:
    1. Public `readonly` properties and configuration options.
    2. Private state fields (maps, database handles, mutexes/locks).
    3. `constructor`.
    4. Public methods grouped by lifecycle and domain (e.g., Table CRUD → User CRUD → Sync/Mutations → Maintenance & Cleanup).
    5. Private helper methods and internal utilities at the very bottom.
- **Minimal Public API Surface**: Only export or make public APIs, types, classes, methods, and properties that are absolutely necessary for consumers. Keep internal implementations, helper utilities, state fields, rate limiters, crypto primitives, lock handlers, and command dispatchers strictly private to their classes and internal modules. Never export internal constants, helpers, or properties just for unit tests. Avoid `index.ts` files for internal-only packages, import the files directly.
- **Private Helpers at the Bottom**: Place private helper methods and internal utility functions at the bottom of classes and files so that the public API and core lifecycle methods appear clearly at the top.
- **No `any` Types**: Never use the `any` type. Leverage strict types, `unknown`, explicit generics (`<T = unknown>`), type narrowing, or specific interfaces/unions instead.
- **Reusability & Duplication**: Reuse logic, types, and utility functions across modules. Refactor shared functions into utility modules (`src/shared/`). Do not duplicate code.
- **Nullish Coalescing (`??`) for Fallbacks**: Always use the nullish coalescing operator (`??`) when assigning default fallback values for `null` or `undefined`. Reserve `||` exclusively for boolean logical condition checks.
- **No Loose Object Records (`Record<string, any>`)**: Prefer explicit typed interfaces, `Map` / `ReadonlyMap`, and `Set` / `ReadonlySet` over generic object records (`Record<string, string>` or `Record<string, any>`).
- **Backward Compatibility Boundaries**: Preserve backward compatibility for public APIs and persistent storage layers against the last public release (tagged with git). For internal code, transient data structures, and test suites, refactor directly without retaining legacy aliases or wrapper cruft.
- **Immediate Cleanup**: Clean up after yourself immediately. Delete unused methods, properties, variables, types, and imports during refactoring.
- **No Inline Imports**: All imports must be declared as static top-level `import` statements at the very top of the file. Never use inline `import('...')` type queries or inline dynamic imports within code, type annotations, or function signatures.
- **Indentation**: Always use 2 spaces for indentation across all code and configuration files.
- **Quality Loop**: Before submitting or after making any code change, execute the validation loop:
  1. `npm run format` — Auto-format code files.
  2. `npm run lint` — Check and fix lint/style issues.
  3. `npm test` — Run unit and integration test suites.
  4. `npm run typecheck` — Verify strict TypeScript compilation with no type errors.
  5. `npm run build` — Verify production bundle builds (ESM, CJS, and `.d.ts`).
- **Commit Messages**: When explicitly asked to commit changes, use a concise, human-readable title matching the topic of the current conversation since the last commit (use proper capitalization, no prefixes like `feat:` or `fix:`). Never push or pull changes to remote repositories.

## 📂 Architecture Overview

The codebase is organized into five decoupled layers with clear subpath exports:

- **Shared / Protocol (`src/shared/`)**:
  - Internal module (not exported publicly).
  - Single source of truth for protocol message schemas, data structures, logical clocks, and path normalization shared internally across client and server.
  - Pure TypeScript with zero runtime dependencies.
- **Client Layer (`src/client/`)**:
  - Exported as `tetherdb/client`.
  - **TetherClient (`client.ts`)**: Main reactive facade client with local-first storage, multi-app support, auto-session, and auth helpers.
  - **Auth (`auth.ts`)**: Internal authentication coordinator managing sessions, metadata, and auth HTTP endpoints.
  - **Storage (`storage/`)**: Atomic transaction coordinator (`storage.ts`), IndexedDB connection & schema upgrades (`database.ts`), and IDB utilities (`utils.ts`).
  - **Tables (`table.ts`)**: Typed table wrappers providing local-first CRUD operations and reactive event subscriptions.
  - **Indexes (`indexed.ts`)**: First-class declarative `Index` definitions, query methods, and reactive subscription views.
  - **Sync (`sync/`)**: Two-way WebSocket sync coordinator (`sync.ts`) and connection manager with auto-reconnect backoff (`connection.ts`).
- **Server Layer (`src/server/`)**:
  - Exported as `tetherdb/server`.
  - **Server (`server.ts`)**: Unified HTTP and WebSocket server (`TetherServer`, `startServer`) handling authentication endpoints, health/readiness/metrics, and real-time synchronization.
  - **Storage (`storage/`)**: Storage abstraction (`storage.ts`), common base (`base.ts`), with implementations for in-memory testing (`memory.ts`), per-user filesystem directories (`file.ts`), and SQLite (`sqlite.ts`), unified table (`table.ts`) and user (`user.ts`).
  - **Security (`security/`)**: Centralized authorization and response fattening pipeline (`filter.ts`), caching user resolver (`resolver.ts`), and internal schemas (`types.ts`).
  - **Locking (`shared/lock.ts`)**: Exclusive server process lockfile management (`server.lock`) and stale PID crash recovery.
  - **Authentication (`shared/crypto.ts`)**: Internal token signing, password hashing, and persistent keyfile management.
  - **Sync (`sync.ts`)**: Internal WebSocket connection hub and broadcast engine.
- **CLI Layer (`src/cli/`)**:
  - Exported as `tetherdb/cli` (`runCli`).
  - **CLI Runner (`cli.ts`)**: Main dispatch entry point for command line execution.
  - **Argument Parsing (`args.ts`)**: Command line option parsing and validation.
  - **Backend Factory (`backend.ts`)**: Storage engine instantiation for memory, file, and sqlite targets.
  - **Commands (`commands/`)**: Modular subcommand handlers (`serve.ts`, `status.ts`, `stop.ts`, `migrate/`, `maintenance.ts`, `tables.ts`, `records.ts`, `users.ts`, `help.ts`).
- **Vite Layer (`src/vite/`)**:
  - Exported as `tetherdb/vite`.
  - **Vite Plugin (`index.ts`)**: Zero-config local development integration (`tetherPlugin`) running embedded WebSocket sync and REST auth directly within Vite dev and preview servers.

## 🔑 Key TypeScript & Design Conventions

1. **Strict Type Safety**: Never use `any` unless strictly necessary for generic boundaries. Leverage generics (`<T = unknown>`) and discriminated unions for message types.
2. **Explicit Enums & Discriminated Unions**: Use discriminated union types for message protocols (`ClientMessage`, `ServerMessage`) and explicit enum/literal types for operational states (`SyncStatus`, `OperationType`).
3. **Pluggable & Extensible Abstractions**: Components requiring alternative backend implementations (such as storage persistence or WebSocket transports) must adhere to clear TypeScript interfaces (e.g. `Storage`, `AppStorage`, `TableStorage`, `UserStorage`).
4. **Local-First Consistency**:
   - Write operations must complete locally in IndexedDB first.
   - Outbox logs and data mutations must execute atomically within the same IndexedDB transaction.
   - Remote changes applied locally must never generate reciprocal outbox entries (preventing echo loops).
5. **Deterministic Conflict Resolution**: Resolve conflicting updates using monotonically increasing timestamps with client ID tie-breaking.

## 🧪 Testing Rules

- **Zero Test Side Effects**: Tests must be fully isolated and clean up resources (`afterEach`), including closing server listeners, active WebSockets, IndexedDB connections, and temporary filesystem directories.
- **Fast Unit Tests**: Test core components (`TetherClient`, `Table`, `Storage`, `MemoryStorage`, `FileStorage`, `SqliteStorage`, `Sync`) in isolation.
- **Describe & It Blocks**: `describe` blocks must never contain filenames or generic module names, only class, component, or function/method names. `it` blocks must concisely describe what is under test and the expected behavior, without repeating the class or function name.
- **End-to-End Sync Tests**: End-to-end tests must verify real-time multi-client scenarios:
  - Initial snapshot delivery on fresh client connection.
  - Delta diff catch-up after offline reconnect.
  - Real-time change broadcasting between concurrent clients.
  - Multi-tenant data isolation across different user accounts.
  - Last-Write-Wins conflict resolution convergence.
