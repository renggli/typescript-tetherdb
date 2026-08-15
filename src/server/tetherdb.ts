#!/usr/bin/env node
import * as path from 'node:path';
import type { ServerLimits } from '../shared/types.js';
import type { AuthAdapter } from './auth/adapter.js';
import { FileAuthAdapter } from './auth/file.js';
import { MemoryAuthAdapter } from './auth/memory.js';
import { SqliteAuthAdapter } from './auth/sqlite.js';
import { startServer } from './server.js';
import type { StorageAdapter } from './storage/adapter.js';
import { FileStorageAdapter } from './storage/file.js';
import { MemoryStorageAdapter } from './storage/memory.js';
import { SqliteStorageAdapter } from './storage/sqlite.js';

/**
 * Parses an auth backend specification string into an AuthAdapter instance.
 *
 * Supported formats:
 * - `memory` (default)
 * - `sqlite:<dir>` or `sqlite` (defaults to `<dir>/auth.sqlite`, baseDir defaults to `.data`)
 * - `file:<dir>` or `file` (defaults to `<dir>/auth/`, baseDir defaults to `.data`)
 *
 * @param spec - Auth backend specification string.
 * @param baseDir - Optional default fallback directory if unspecified in spec.
 * @returns Instantiated AuthAdapter.
 */
export function parseAuthSpec(spec?: string, baseDir?: string): AuthAdapter {
  if (!spec || spec === 'memory') {
    return new MemoryAuthAdapter();
  }
  if (spec.startsWith('sqlite:')) {
    const dir = spec.slice('sqlite:'.length);
    return new SqliteAuthAdapter({
      baseDir: dir ? path.resolve(dir) : path.resolve(baseDir ?? '.data'),
    });
  }
  if (spec === 'sqlite') {
    return new SqliteAuthAdapter({
      baseDir: path.resolve(baseDir ?? '.data'),
    });
  }
  if (spec.startsWith('file:')) {
    const dir = spec.slice('file:'.length);
    return new FileAuthAdapter({
      baseDir: dir ? path.resolve(dir) : path.resolve(baseDir ?? '.data'),
    });
  }
  if (spec === 'file') {
    return new FileAuthAdapter({
      baseDir: path.resolve(baseDir ?? '.data'),
    });
  }
  throw new Error(
    `Unknown auth spec: "${spec}". Expected memory, sqlite:<dir>, or file:<dir>.`,
  );
}

/**
 * Parses a storage backend specification string into a StorageAdapter instance.
 *
 * Supported formats:
 * - `memory` (default)
 * - `sqlite:<dir>` or `sqlite` (creates `<dir>/<appId>.sqlite` per app, baseDir defaults to `.data`)
 * - `file:<dir>` or `file` (creates `<dir>/<appId>/...` per app, baseDir defaults to `.data`)
 *
 * @param spec - Storage backend specification string.
 * @param baseDir - Optional default fallback directory if unspecified in spec.
 * @param limits - Optional server limits configuration.
 * @returns Instantiated StorageAdapter.
 */
export function parseStorageSpec(
  spec?: string,
  baseDir?: string,
  limits?: ServerLimits,
): StorageAdapter {
  if (!spec || spec === 'memory') {
    return new MemoryStorageAdapter({ limits });
  }
  if (spec.startsWith('sqlite:')) {
    const dir = spec.slice('sqlite:'.length);
    return new SqliteStorageAdapter({
      baseDir: dir ? path.resolve(dir) : path.resolve(baseDir ?? '.data'),
      limits,
    });
  }
  if (spec === 'sqlite') {
    return new SqliteStorageAdapter({
      baseDir: path.resolve(baseDir ?? '.data'),
      limits,
    });
  }
  if (spec.startsWith('file:')) {
    const dir = spec.slice('file:'.length);
    return new FileStorageAdapter({
      baseDir: dir ? path.resolve(dir) : path.resolve(baseDir ?? '.data'),
      limits,
    });
  }
  if (spec === 'file') {
    return new FileStorageAdapter({
      baseDir: path.resolve(baseDir ?? '.data'),
      limits,
    });
  }
  throw new Error(
    `Unknown storage spec: "${spec}". Expected memory, sqlite:<dir>, or file:<dir>.`,
  );
}

/**
 * Standard command line interface for launching a TetherDB server.
 */
export async function runCli(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
TetherDB Standard Server

Usage:
  npx tetherdb [options]
  tetherdb [options]

Options:
  --port, -p <number>                         Port number to bind (default: 8080 or PORT env)
  --host, -H <string>                         Host address to bind (default: 0.0.0.0 or HOST env)
  --auth, -a <memory|sqlite:dir|file:dir>     Auth backend (default: memory)
  --storage, -s <memory|sqlite:dir|file:dir>  Storage backend (default: memory)
  --dir, -d <dir>                             Directory for data & auth (default: .data)
  --help, -h                                  Show this help message

Endpoints:
  WS   /sync              WebSocket real-time sync stream
  POST /auth/register     User account registration
  POST /auth/login        User account login
  GET  /apps              List active applications
  GET  /apps/:id/tables   List tables for an app (requires Bearer token)
  GET  /health            Server liveness health check
`);
    return;
  }

  let port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8080;
  let host = process.env.HOST ?? '0.0.0.0';
  let baseDir = '.data';
  let authSpec: string | undefined;
  let storageSpec: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '-p') {
      const val = args[++i];
      if (val) port = Number.parseInt(val, 10);
    } else if (arg.startsWith('--port=')) {
      port = Number.parseInt(arg.slice('--port='.length), 10);
    } else if (arg === '--host' || arg === '-H') {
      const val = args[++i];
      if (val) host = val;
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    } else if (arg === '--auth' || arg === '-a') {
      authSpec = args[++i];
    } else if (arg.startsWith('--auth=')) {
      authSpec = arg.slice('--auth='.length);
    } else if (arg === '--storage' || arg === '-s') {
      storageSpec = args[++i];
    } else if (arg.startsWith('--storage=')) {
      storageSpec = arg.slice('--storage='.length);
    } else if (arg === '--dir' || arg === '-d') {
      const val = args[++i];
      if (val) baseDir = val;
    } else if (arg.startsWith('--dir=')) {
      baseDir = arg.slice('--dir='.length);
    }
  }

  const auth = parseAuthSpec(authSpec, baseDir);
  const storage = parseStorageSpec(storageSpec, baseDir);

  const running = await startServer({
    port,
    host,
    auth,
    storage,
  });

  const authDesc = authSpec ?? 'memory';
  const storageDesc = storageSpec ?? 'memory';

  console.log(`
⚡ TetherDB Server running at: http://${running.host === '0.0.0.0' ? 'localhost' : running.host}:${running.port}
🔒 Auth backend:              ${authDesc}
💾 Storage backend:           ${storageDesc}
🔌 WebSocket Sync endpoint:   ws://${running.host === '0.0.0.0' ? 'localhost' : running.host}:${running.port}/sync
✨ Multi-application ready on standard domain.
`);

  const shutdown = async () => {
    console.log('\nStopping TetherDB server...');
    await running.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1]?.endsWith('tetherdb.ts')) {
  runCli().catch((err) => {
    console.error('Failed to start TetherDB server:', err);
    process.exit(1);
  });
}
