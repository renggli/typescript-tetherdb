#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './server.js';
import { FileStorage } from './storage/file/index.js';
import { MemoryStorage } from './storage/memory/index.js';
import { SqliteStorage } from './storage/sqlite/index.js';
import type { Storage, StorageOptions } from './storage/storage.js';

/**
 * Backend persistence type for TetherDB server.
 */
export type BackendType = 'memory' | 'file' | 'sqlite';

/**
 * Instantiates the matching Storage implementation for a given backend type and directory.
 *
 * @param backend - Target backend ('memory', 'file', or 'sqlite'). Defaults to 'memory'.
 * @param baseDir - Directory path for file and sqlite backends. Defaults to '.data'.
 * @param options - Optional storage configuration and limits.
 * @returns Instantiated `Storage` engine.
 */
export function createBackend(
  backend: BackendType = 'memory',
  baseDir: string = '.data',
  options?: StorageOptions,
): Storage {
  const resolvedDir = path.resolve(baseDir);

  switch (backend) {
    case 'memory':
      return new MemoryStorage(options);
    case 'sqlite':
      return new SqliteStorage({ baseDir: resolvedDir, ...options });
    case 'file':
      return new FileStorage({ baseDir: resolvedDir, ...options });
    default:
      throw new Error(
        `Unknown backend type: "${backend}". Expected 'memory', 'file', or 'sqlite'.`,
      );
  }
}

/**
 * Standard command line interface for TetherDB.
 *
 * Commands:
 * - `serve` (default): Starts HTTP & WebSocket sync server
 * - `apps` / `apps list`: Lists registered applications
 * - `apps add <appid>`: Registers a new application
 * - `apps rm <appid>`: Deletes an application and all its data
 * - `tables` / `tables list [appid]`: Lists tables registered for an application
 * - `tables add <appid> <table1> [table2...]`: Registers one or more tables for an application
 * - `tables rm <appid> <table1> [table2...]`: Deletes table(s) from an application
 * - `users` / `users list`: Lists registered user accounts
 * - `users add <username> <password>`: Registers a new user account
 * - `users rm <userid>`: Deletes a user account and their data
 */
export async function runCli(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
TetherDB CLI

Usage:
  npx tetherdb [command] [options]
  tetherdb [command] [options]

Commands:
  serve (default)                         Start HTTP and WebSocket synchronization server
  apps [list]                             List all applications
  apps add <appid>                        Register a new application
  apps rm <appid>                         Delete an application and its data
  tables [list] [appid]                   List tables for an application (default: default)
  tables add <appid> <table1> [table2...] Add one or more tables to an application
  tables rm <appid> <table1> [table2...]  Remove table(s) from an application
  users [list]                            List all registered user accounts
  users add <username> <password>         Register a new user account
  users rm <userid>                       Delete a user account and associated data

Server Options (for 'serve'):
  --port=<number>, -p <number>            Port number to bind (default: 8080 or PORT env)
  --host=<string>, -H <string>            Host address to bind (default: 0.0.0.0 or HOST env)

Backend Options (for all commands):
  --memory                                Run in-memory without disk persistence (default)
  --file[=<dir>]                          Use filesystem directory for auth and data (default: .data)
  --sqlite[=<dir>]                        Use SQLite databases for auth and data (default: .data)
  --help, -h                              Show this help message
`);
    return;
  }

  let storage: Storage | undefined;

  try {
    let command = 'serve';
    const positionalArgs: string[] = [];
    let port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8080;
    let host = process.env.HOST ?? '0.0.0.0';
    let backend: BackendType = 'memory';
    let dir = '.data';

    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg.startsWith('--port=')) {
        port = Number.parseInt(arg.slice(7), 10);
      } else if (arg === '-p') {
        port = Number.parseInt(args[++i] ?? '', 10);
      } else if (arg.startsWith('--host=')) {
        host = arg.slice(7);
      } else if (arg === '-H') {
        host = args[++i] ?? host;
      } else if (arg === '--memory') {
        backend = 'memory';
      } else if (arg === '--file' || arg.startsWith('--file=')) {
        backend = 'file';
        if (arg.startsWith('--file=')) dir = arg.slice(7);
      } else if (arg === '--sqlite' || arg.startsWith('--sqlite=')) {
        backend = 'sqlite';
        if (arg.startsWith('--sqlite=')) dir = arg.slice(9);
      } else if (arg.startsWith('-')) {
        throw new Error(`Unknown or invalid option: "${arg}".`);
      } else {
        positionalArgs.push(arg);
      }
    }

    if (positionalArgs.length > 0) {
      command = positionalArgs[0];
    }

    storage = createBackend(backend, dir);
    switch (command) {
      case 'serve': {
        const running = await startServer({
          port,
          host,
          storage,
        });

        const backendDesc =
          backend === 'memory'
            ? 'memory (ephemeral)'
            : `${backend} (${path.resolve(dir)})`;

        console.log(`
⚡ TetherDB Server running at: http://${running.host === '0.0.0.0' ? 'localhost' : running.host}:${running.port}
💾 Backend mode:              ${backendDesc}
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
        break;
      }

      case 'apps': {
        const action = positionalArgs[1] ?? 'list';
        if (action === 'list') {
          const apps = await storage.getApps();
          if (apps.length === 0) {
            console.log('No applications found.');
          } else {
            console.log(`Applications (${apps.length}):`);
            for (const app of apps) {
              const tables = await app.getTables();
              const tableList =
                tables.length > 0
                  ? tables.map((t) => t.name).join(', ')
                  : 'no tables';
              console.log(`  • ${app.id} (tables: ${tableList})`);
            }
          }
        } else if (action === 'add') {
          const appId = positionalArgs[2];
          if (!appId) {
            throw new Error('Usage: tetherdb apps add <appid>');
          }
          const existing = await storage.getApp(appId);
          if (existing) {
            console.log(`Application already exists: ${appId}`);
          } else {
            await storage.createApp(appId);
            console.log(`Created application: ${appId}`);
          }
        } else if (action === 'rm') {
          const appId = positionalArgs[2];
          if (!appId) {
            throw new Error('Usage: tetherdb apps rm <appid>');
          }
          const app = await storage.getApp(appId);
          if (app) {
            await app.delete();
            console.log(`Deleted application: ${appId}`);
          } else {
            console.log(`Application not found: ${appId}`);
          }
        } else {
          throw new Error(
            `Unknown apps action: "${action}". Usage: apps [list|add <appid>|rm <appid>]`,
          );
        }
        await storage.close?.();
        break;
      }

      case 'tables': {
        const action = positionalArgs[1] ?? 'list';
        if (action === 'list') {
          const appId = positionalArgs[2] ?? 'default';
          const app = await storage.getApp(appId);
          const tables = app ? await app.getTables() : [];
          if (tables.length === 0) {
            console.log(`No tables found for application "${appId}".`);
          } else {
            console.log(
              `Tables for application "${appId}" (${tables.length}):`,
            );
            for (const t of tables) {
              console.log(`  • ${t.name}`);
            }
          }
        } else if (action === 'add') {
          const appId = positionalArgs[2];
          const tableNames = positionalArgs.slice(3);
          if (!appId || tableNames.length === 0) {
            throw new Error(
              'Usage: tetherdb tables add <appid> <table1> [table2...]',
            );
          }
          const app = await storage.getApp(appId);
          if (!app) {
            throw new Error(
              `Application "${appId}" not found. Create it first with: tetherdb apps add ${appId}`,
            );
          }
          for (const t of tableNames) {
            const existing = await app.getTable(t);
            if (existing) {
              console.log(
                `Table "${t}" already exists in application "${appId}"`,
              );
            } else {
              await app.createTable(t);
              console.log(`Added table "${t}" to application "${appId}"`);
            }
          }
        } else if (action === 'rm') {
          const appId = positionalArgs[2];
          const tableNames = positionalArgs.slice(3);
          if (!appId || tableNames.length === 0) {
            throw new Error(
              'Usage: tetherdb tables rm <appid> <table1> [table2...]',
            );
          }
          const app = await storage.getApp(appId);
          if (!app) {
            throw new Error(`Application "${appId}" not found.`);
          }
          for (const t of tableNames) {
            const table = await app.getTable(t);
            if (table) {
              await table.delete();
              console.log(`Removed table "${t}" from application "${appId}"`);
            } else {
              console.log(`Table "${t}" not found in application "${appId}"`);
            }
          }
        } else {
          // If first arg after tables is an app name: "tables <appid>"
          const appId = action;
          const app = await storage.getApp(appId);
          const tables = app ? await app.getTables() : [];
          if (tables.length === 0) {
            console.log(`No tables found for application "${appId}".`);
          } else {
            console.log(
              `Tables for application "${appId}" (${tables.length}):`,
            );
            for (const t of tables) {
              console.log(`  • ${t.name}`);
            }
          }
        }
        await storage.close?.();
        break;
      }

      case 'users': {
        const action = positionalArgs[1] ?? 'list';
        if (action === 'list') {
          const users = await storage.getUsers();
          if (users.length === 0) {
            console.log('No registered users found.');
          } else {
            console.log(`Registered users (${users.length}):`);
            for (const u of users) {
              const created = new Date(u.createdAt).toISOString();
              console.log(`  • [${u.id}] ${u.username} (created: ${created})`);
            }
          }
        } else if (action === 'add') {
          const username = positionalArgs[2];
          const password = positionalArgs[3];
          if (!username || !password) {
            throw new Error('Usage: tetherdb users add <username> <password>');
          }
          const user = await storage.createUser(username, password);
          console.log(`Created user: [${user.id}] ${user.username}`);
        } else if (action === 'rm') {
          const userId = positionalArgs[2];
          if (!userId) {
            throw new Error('Usage: tetherdb users rm <userid>');
          }
          const user = await storage.getUser(userId);
          if (user) {
            await user.delete();
            console.log(`Deleted user: ${userId}`);
          } else {
            console.log(`User not found: ${userId}`);
          }
        } else {
          throw new Error(
            `Unknown users action: "${action}". Usage: users [list|add <username> <password>|rm <userid>]`,
          );
        }
        await storage.close?.();
        break;
      }

      default:
        throw new Error(
          `Unknown command: "${command}". Run 'tetherdb --help' for available commands.`,
        );
    }
  } catch (err) {
    console.error('Command failed:', (err as Error).message);
    await storage?.close?.();
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  runCli().catch((err) => {
    console.error('Failed to start TetherDB CLI:', err);
    process.exit(1);
  });
}
