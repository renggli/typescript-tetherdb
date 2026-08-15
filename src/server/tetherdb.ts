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
 * Displays command-line interface usage instructions.
 */
export function printHelp(): void {
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
  tables [list] <appid>                   List tables for an application
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
}

/**
 * Parsed CLI arguments and configuration options.
 */
export interface ParsedCliArgs {
  command: string;
  positionalArgs: string[];
  port: number;
  host: string;
  backend: BackendType;
  dir: string;
}

/**
 * Parses raw command-line arguments into structured options.
 *
 * @param args - Command line arguments.
 * @returns Parsed CLI configuration.
 */
export function parseCliArgs(args: string[]): ParsedCliArgs {
  const positionalArgs: string[] = [];
  let port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 8080;
  let host = process.env.HOST ?? '0.0.0.0';
  let backend: BackendType = 'memory';
  let dir = '.data';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--port=')) port = Number.parseInt(arg.slice(7), 10);
    else if (arg === '-p') port = Number.parseInt(args[++i] ?? '', 10);
    else if (arg.startsWith('--host=')) host = arg.slice(7);
    else if (arg === '-H') host = args[++i] ?? host;
    else if (arg === '--memory') backend = 'memory';
    else if (arg === '--file' || arg.startsWith('--file=')) {
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

  return {
    command: positionalArgs[0] ?? 'serve',
    positionalArgs,
    port,
    host,
    backend,
    dir,
  };
}

/**
 * Handles the 'serve' command to launch the HTTP and WebSocket synchronization server.
 */
export async function handleServeCommand(
  storage: Storage,
  backend: BackendType,
  dir: string,
  port: number,
  host: string,
): Promise<void> {
  const running = await startServer({ port, host, storage });
  const backendDesc =
    backend === 'memory'
      ? 'memory (ephemeral)'
      : `${backend} (${path.resolve(dir)})`;
  const domainPort = `${running.host === '0.0.0.0' ? 'localhost' : running.host}:${running.port}`;
  console.log(`⚡ TetherDB running at: http://${domainPort}`);
  console.log(`🔌 WebSocket Sync endpoint: ws://${domainPort}/sync`);
  console.log(`💾 Backend mode: ${backendDesc}`);
  const shutdown = async () => {
    console.log('Stopping TetherDB server...');
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Handles the 'apps' command family (list, add, rm).
 */
export async function handleAppsCommand(
  storage: Storage,
  [, action = 'list', appId]: string[],
): Promise<void> {
  if (action === 'list') {
    const apps = await storage.getApps();
    if (!apps.length) return console.log('No applications found.');
    console.log(`Applications (${apps.length}):`);
    for (const app of apps) {
      const tables = await app.getTables();
      const tableList = tables.map((t) => t.name).join(', ') || 'no tables';
      console.log(`  • ${app.id} (tables: ${tableList})`);
    }
  } else if (action === 'add') {
    if (!appId) throw new Error('Missing application ID.');
    if (await storage.getApp(appId)) {
      return console.log(`Application already exists: ${appId}`);
    }
    await storage.createApp(appId);
    console.log(`Created application: ${appId}`);
  } else if (action === 'rm') {
    if (!appId) throw new Error('Missing application ID.');
    const app = await storage.getApp(appId);
    if (!app) return console.log(`Application not found: ${appId}`);
    await app.delete();
    console.log(`Deleted application: ${appId}`);
  } else {
    throw new Error(`Unknown apps action: "${action}".`);
  }
}

/**
 * Handles the 'tables' command family (list, add, rm, <appid>).
 */
export async function handleTablesCommand(
  storage: Storage,
  args: string[],
): Promise<void> {
  const action = args[1] ?? 'list';
  if (action === 'add' || action === 'rm') {
    const appId = args[2];
    if (!appId) throw new Error('Missing application ID.');
    const tableNames = args.slice(3);
    if (!tableNames.length) throw new Error('Missing table name.');
    const app = await storage.getApp(appId);
    if (!app) throw new Error(`Application "${appId}" not found.`);
    for (const tableName of tableNames) {
      if (action === 'add') {
        if (await app.getTable(tableName)) {
          console.log(
            `Table "${tableName}" already exists in application "${appId}"`,
          );
        } else {
          await app.createTable(tableName);
          console.log(`Added table "${tableName}" to application "${appId}"`);
        }
      } else {
        const table = await app.getTable(tableName);
        if (!table) {
          console.log(
            `Table "${tableName}" not found in application "${appId}"`,
          );
        } else {
          await table.delete();
          console.log(
            `Removed table "${tableName}" from application "${appId}"`,
          );
        }
      }
    }
  } else {
    const appId = action === 'list' ? args[2] : action;
    if (!appId) throw new Error('Missing application ID.');
    const app = await storage.getApp(appId);
    if (!app) throw new Error(`Application "${appId}" not found.`);
    const tables = await app.getTables();
    if (!tables.length) {
      console.log(`No tables found for application "${appId}".`);
    } else {
      console.log(`Tables for application "${appId}" (${tables.length}):`);
      for (const t of tables) console.log(`  • ${t.name}`);
    }
  }
}

/**
 * Handles the 'users' command family (list, add, rm).
 */
export async function handleUsersCommand(
  storage: Storage,
  [, action = 'list', arg1, arg2]: string[],
): Promise<void> {
  if (action === 'list') {
    const users = await storage.getUsers();
    if (!users.length) return console.log('No registered users found.');
    console.log(`Registered users (${users.length}):`);
    for (const u of users) {
      console.log(
        `  • [${u.id}] ${u.username} (created: ${new Date(u.createdAt).toISOString()})`,
      );
    }
  } else if (action === 'add') {
    if (!arg1) throw new Error('Missing username.');
    if (!arg2) throw new Error('Missing password.');
    const user = await storage.createUser(arg1, arg2);
    console.log(`Created user: [${user.id}] ${user.username}`);
  } else if (action === 'rm') {
    if (!arg1) throw new Error('Missing user ID.');
    const user = await storage.getUser(arg1);
    if (!user) return console.log(`User not found: ${arg1}`);
    await user.delete();
    console.log(`Deleted user: ${arg1}`);
  } else {
    throw new Error(`Unknown users action: "${action}".`);
  }
}

/**
 * Standard command line interface for TetherDB.
 */
export async function runCli(
  args: string[] = process.argv.slice(2),
): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  let storage: Storage | undefined;
  try {
    const { command, positionalArgs, port, host, backend, dir } =
      parseCliArgs(args);
    storage = createBackend(backend, dir);
    switch (command) {
      case 'serve':
        await handleServeCommand(storage, backend, dir, port, host);
        break;
      case 'apps':
        await handleAppsCommand(storage, positionalArgs);
        break;
      case 'tables':
        await handleTablesCommand(storage, positionalArgs);
        break;
      case 'users':
        await handleUsersCommand(storage, positionalArgs);
        break;
      default:
        throw new Error(`Unknown command: "${command}".`);
    }
    await storage.close?.();
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
