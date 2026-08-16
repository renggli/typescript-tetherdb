# TetherDB — AI Developer Guide & Architecture Map

This document outlines the core architecture, developer rules, TypeScript conventions, and testing guidelines for developing TetherDB.

> [!IMPORTANT]
> At this point of the development no backward compatibility is needed: this applies to and is not limited to storage layer, the public APIs, and all types, classes, enums, fields, methods, function, ... Directly update all dependencies, documentation and tests when changing things. Focus on a readable, clean, and elegant implementation without any cruft.

## 🚨 Developer Rules & Quality Checks

- **Structure & Documentation**: Public APIs, exported types, classes, and functions must be placed at the top of the file and thoroughly documented with JSDoc comments. Methods should be concise, focused, and readable. Avoid unnecessary abbreviations in identifiers.
- **Private Helpers at the Bottom**: Place private helper methods and internal utility functions at the bottom of classes and files so that the public API and core lifecycle methods appear clearly at the top.
- **No `any` Types**: Never use the `any` type. Leverage strict types, `unknown`, explicit generics (`<T = unknown>`), type narrowing, or specific interfaces/unions instead.
- **Reusability & Duplication**: Reuse logic, types, and utility functions across modules. Refactor shared functions into utility modules (`src/shared/`). Do not duplicate code.
- **Nullish Coalescing (`??`) for Fallbacks**: Always use the nullish coalescing operator (`??`) when assigning default fallback values for `null` or `undefined`. Reserve `||` exclusively for boolean logical condition checks.
- **No Loose Object Records (`Record<string, any>`)**: Prefer explicit typed interfaces, `Map` / `ReadonlyMap`, and `Set` / `ReadonlySet` over generic object records (`Record<string, string>` or `Record<string, any>`).
- **No Backward Compatibility Without User Approval**: Never keep backward compatibility aliases, wrappers, or legacy exports just for internal code or unit tests—update tests and caller code directly instead.
- **Immediate Cleanup**: Clean up after yourself immediately. Delete unused methods, properties, variables, types, and imports during refactoring.
- **Indentation**: Always use 2 spaces for indentation across all code and configuration files.
- **Quality Loop**: Before submitting or after making any code change, execute the validation loop:
  1. `npm run format` — Auto-format code files.
  2. `npm run check` — Check and fix lint/style issues.
  3. `npm test` — Run unit and integration test suites.
  4. `npm run typecheck` — Verify strict TypeScript compilation with no type errors.
  5. `npm run build` — Verify production bundle builds (ESM, CJS, and `.d.ts`).
- **Commit Messages**: When explicitly asked to commit changes, use a concise, human-readable title matching the topic of the current conversation since the last commit (use proper capitalization, no prefixes like `feat:` or `fix:`). Never push or pull changes to remote repositories.

## 📂 Architecture Overview

The codebase is organized into three decoupled layers with clear subpath exports:

- **Shared / Protocol (`src/shared/`)**:
  - Exported as `tetherdb/shared`.
  - Single source of truth for message schemas, data structures, and conflict resolution logic.
  - Contains deterministic conflict resolution algorithms (Last-Write-Wins with logical timestamps and client ID tie-breaking).
  - Pure TypeScript with zero runtime dependencies.

- **Client Layer (`src/client/`)**:
  - Exported as `tetherdb/client`.
  - **TetherClient (`client.ts`)**: Main reactive facade client with local-first storage, multi-app support, auto-session, and auth helpers.
  - **Auth (`auth.ts`)**: Internal authentication coordinator managing sessions, metadata, and auth HTTP endpoints.
  - **Storage (`storage.ts`)**: Atomic transaction coordinator managing user object stores alongside internal outbox and metadata stores.
  - **Tables (`table.ts`)**: Typed table wrappers providing local-first CRUD operations and reactive event subscriptions.
  - **Sync (`sync.ts`)**: Two-way WebSocket sync coordinator managing initial snapshot / diff downloads, outbox queue flushing, acknowledgments, and auto-reconnect backoff.






- **Server Layer (`src/server/`)**:
  - Exported as `tetherdb/server`.
  - **Authentication (`auth/`)**: Pluggable authentication abstraction with implementations for in-memory testing (`MemoryAuthAdapter`) and filesystem persistence (`FileAuthAdapter`).
  - **Storage Adapters (`storage/`)**: Pluggable storage abstraction with implementations for in-memory testing (`MemoryStorageAdapter`) and per-user filesystem directories (`FileStorageAdapter`).
  - **Sync Hub (`sync-hub.ts`)**: Real-time WebSocket connection manager and user-isolated broadcast engine.
  - **Server (`server.ts`)**: Unified HTTP and WebSocket server handling authentication endpoints and real-time streaming connections.

## 🔑 Key TypeScript & Design Conventions

1. **Strict Type Safety**: Never use `any` unless strictly necessary for generic boundaries. Leverage generics (`<T = unknown>`) and discriminated unions for message types.
2. **Explicit Enums & Discriminated Unions**: Use discriminated union types for message protocols (`ClientMessage`, `ServerMessage`) and explicit enum/literal types for operational states (`SyncStatus`, `OperationType`).
3. **Pluggable & Extensible Abstractions**: Components requiring alternative backend implementations (such as storage persistence, authentication adapters, or WebSocket transports) must adhere to clear TypeScript interfaces (e.g. `StorageAdapter`, `AuthAdapter`).
4. **Local-First Consistency**:
   - Write operations must complete locally in IndexedDB first.
   - Outbox logs and data mutations must execute atomically within the same IndexedDB transaction.
   - Remote changes applied locally must never generate reciprocal outbox entries (preventing echo loops).
5. **Deterministic Conflict Resolution**: Resolve conflicting updates using monotonically increasing timestamps with client ID tie-breaking.

## 🧪 Testing Rules

- **Zero Test Side Effects**: Tests must be fully isolated and clean up resources (`afterEach`), including closing server listeners, active WebSockets, IndexedDB connections, and temporary filesystem directories.
- **Fast Unit Tests**: Test core components (`Database`, `Table`, `MemoryAuthAdapter`, `FileAuthAdapter`, `MemoryStorageAdapter`) in isolation.

- **End-to-End Sync Tests**: End-to-end tests must verify real-time multi-client scenarios:
  - Initial snapshot delivery on fresh client connection.
  - Delta diff catch-up after offline reconnect.
  - Real-time change broadcasting between concurrent clients.
  - Multi-tenant data isolation across different user accounts.
  - Last-Write-Wins conflict resolution convergence.
