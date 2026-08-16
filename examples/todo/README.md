# TetherDB Todo Example

A real-time, local-first Todo application demonstrating two-way synchronization and offline persistence with TetherDB.

The application reads and writes directly to browser IndexedDB for zero-latency local operations, while a background WebSocket connection streams mutations across active clients and devices in real time. When offline, changes queue locally in IndexedDB and reconcile automatically with the server upon reconnection using deterministic Last-Write-Wins conflict resolution.

## How to Run

From the repository root:

```bash
npm run example:todo
```

Or from the `examples/todo` directory:

```bash
npm run dev
```

Open **http://localhost:3000** across multiple devices, browsers, or tabs to observe real-time synchronization, user switching, and offline editing.
