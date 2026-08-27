# TetherDB Client API Explorer & Stress Tester

An interactive playground and benchmark suite for testing and stress testing the client-side of TetherDB.

## Features

- **Interactive Table Management**: Create and switch between tables on the fly.
- **CRUD Operations**: Inspect single and batched operations (`get`, `put`, `delete`, `putAll`, `deleteAll`, `getAll`, `count`, `clear`).
- **Dynamic Index Management**: Declare indexes with custom key paths, uniqueness, and multi-entry array settings, and run range queries with `IndexRange` (`exact`, `startsWith`, `between`, `greaterThan`, `lessThan`).
- **Real-Time Reactive Log**: Stream local IndexedDB operations and incoming two-way WebSocket sync broadcasts.
- **Stress & Benchmark Suite**:
  - **Bulk Batched Writes (`putAll`)**: Benchmark local transaction throughput up to 10,000+ records.
  - **Sequential Unbatched Writes (`put`)**: Test transaction loop overhead.
  - **Read Throughput**: Single `get` vs Table `getAll` vs Index scan.
  - **Mixed Real-World Workload**: Concurrent reads, writes, and deletes.
  - **Configurable Generator**: Custom payload sizes, batch sizes, and operation counts.
  - **Live Metrics**: Real-time throughput (ops/sec), elapsed duration, and latency breakdown with historical run tracking.

## Running the Playground

From the repository root:

```bash
npm run example:playground
```

Or from the `examples/playground` directory:

```bash
npm run dev
```

Open **http://localhost:3001** to access the playground. Open multiple tabs or windows to test real-time WebSocket sync and concurrent stress workloads across sessions!
