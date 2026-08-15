#!/usr/bin/env node
import * as path from 'node:path';
import { startServer } from './server.js';

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
  --port, -p <number>     Port number to bind (default: 8080 or PORT env)
  --host, -H <string>     Host address to bind (default: 0.0.0.0 or HOST env)
  --dir, -d <path>        Filesystem root directory for data (default: .data)
  --help, -h              Show this help message

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
  let storageDir = path.resolve(process.cwd(), '.data');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--port' || arg === '-p') {
      const val = args[++i];
      if (val) port = Number.parseInt(val, 10);
    } else if (arg === '--host' || arg === '-H') {
      const val = args[++i];
      if (val) host = val;
    } else if (arg === '--dir' || arg === '-d') {
      const val = args[++i];
      if (val) storageDir = path.resolve(val);
    }
  }

  const running = await startServer({
    port,
    host,
    storageDir,
  });

  console.log(`
⚡ TetherDB Server running at: http://${running.host === '0.0.0.0' ? 'localhost' : running.host}:${running.port}
📁 Data storage directory:   ${storageDir}
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

// Auto-run if executed directly
if (
  process.argv[1]?.endsWith('tetherdb.ts') ||
  process.argv[1]?.endsWith('tetherdb.js')
) {
  runCli().catch((err) => {
    console.error('Failed to start TetherDB server:', err);
    process.exit(1);
  });
}
