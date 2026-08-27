#!/usr/bin/env node
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TetherServerError, TetherServerErrorCode } from '../server/index.js';
import { type ResolvedAdminContext, resolveAdminTarget } from './admin.js';
import { parseCliArgs } from './args.js';
import { createBackend } from './backend.js';
import {
  handleMaintenanceCommand,
  handleMigrateCommand,
  handleRecordsCommand,
  handleServeCommand,
  handleStatusCommand,
  handleStopCommand,
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
  if (isHelpRequested(args)) {
    printHelp();
    return;
  }
  let adminContext: ResolvedAdminContext | undefined;
  try {
    const { command, positionalArgs, port, host, backend, dir } =
      parseCliArgs(args);
    if (command === 'migrate') {
      await handleMigrateCommand(positionalArgs, backend, dir);
      return;
    }
    if (command === 'stop') {
      await handleStopCommand(dir);
      return;
    }
    if (command === 'serve') {
      const storage = createBackend(backend, dir);
      await handleServeCommand(storage, backend, dir, port, host);
      return;
    }

    adminContext = await resolveAdminTarget(dir, backend);
    switch (command) {
      case 'status':
        await handleStatusCommand(
          adminContext.target,
          positionalArgs,
          adminContext.lock,
        );
        break;
      case 'maintenance':
        await handleMaintenanceCommand(adminContext.target, positionalArgs);
        break;
      case 'tables':
        await handleTablesCommand(adminContext.target, positionalArgs);
        break;
      case 'records':
        await handleRecordsCommand(adminContext.target, positionalArgs);
        break;
      case 'users':
        await handleUsersCommand(adminContext.target, positionalArgs);
        break;
      default:
        throw new TetherServerError(
          TetherServerErrorCode.ConfigurationError,
          `Unknown command: "${command}"`,
        );
    }
    await adminContext.close();
  } catch (err) {
    console.error(`Command failed: ${(err as Error).message}`);
    await adminContext?.close();
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

// -- Private Helpers --------------------------------------------------------

function isHelpRequested(args: string[]): boolean {
  return args.some(
    (arg) =>
      arg === 'help' ||
      arg === '--help' ||
      arg === '-h' ||
      arg === '-?' ||
      arg === '/?' ||
      arg === '-help',
  );
}
