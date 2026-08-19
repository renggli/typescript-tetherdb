#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../server/index.js';
import { parseCliArgs } from './args.js';
import { createBackend } from './backend.js';
import {
  handleAppsCommand,
  handleMaintenanceCommand,
  handleServeCommand,
  handleStatusCommand,
  handleTablesCommand,
  handleUsersCommand,
  printHelp,
} from './commands/index.js';

/**
 * Standard command line interface for TetherDB.
 *
 * @param args - CLI arguments (defaults to process.argv.slice(2)).
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
      case 'status':
        await handleStatusCommand(storage, positionalArgs);
        break;
      case 'maintenance':
        await handleMaintenanceCommand(storage, positionalArgs);
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
        throw new TetherServerError(
          TetherServerErrorCode.ConfigurationError,
          `Unknown command: "${command}".`,
        );
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
