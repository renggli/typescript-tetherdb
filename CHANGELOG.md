# Changelog

All notable changes to this project will be documented in this file.

## [0.1.1] - 2026-08-23

- Add `tetherPlugin` (`tetherdb/vite`) for zero-config Vite dev and preview servers.
- Add `TetherServer.prototype.createMiddleware()` for Connect and Express integration.
- Improve `TetherServer.prototype.attach()` to coexist with other WebSocket handlers.
- Simplify Todo example to use Vite plugin.

## [0.1.0] - 2026-08-20

- Initial release.
- Offline-first IndexedDB client with real-time two-way WebSocket sync (`tetherdb/client`).
- Server with SQLite, filesystem, and in-memory storage backends (`tetherdb/server`).
- CLI tool for server management and maintenance (`tetherdb/cli`).
