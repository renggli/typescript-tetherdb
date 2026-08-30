import { TetherServerError, TetherServerErrorCode } from '../server/errors.js';
import { StorageType } from '../server/storage/storage.js';

/**
 * Parsed CLI arguments and configuration options.
 */
export interface ParsedCliArgs {
  command: string;
  positionalArgs: string[];
  backend: StorageType;
  dir: string;
  host: string;
  port: number;
  token?: string;
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
  let backend: StorageType = StorageType.Memory;
  let dir = '.data';
  let token: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--port=')) {
      port = Number.parseInt(arg.slice(7), 10);
    } else if (arg === '-p' || arg === '--port') {
      port = Number.parseInt(args[++i] ?? '', 10);
    } else if (arg.startsWith('--host=')) {
      host = arg.slice(7);
    } else if (arg === '-H' || arg === '--host') {
      host = args[++i] ?? host;
    } else if (arg.startsWith('--dir=')) {
      dir = arg.slice(6);
    } else if (arg === '-d' || arg === '--dir') {
      dir = args[++i] ?? dir;
    } else if (arg.startsWith('--backend=')) {
      backend = parseBackend(arg.slice(10));
    } else if (arg === '-b' || arg === '--backend') {
      backend = parseBackend(args[++i] ?? '');
    } else if (arg.startsWith('--memory=')) {
      backend = StorageType.Memory;
      token = arg.slice(9);
    } else if (arg === '--memory') {
      backend = StorageType.Memory;
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        token = args[++i];
      }
    } else if (arg.startsWith('--token=')) {
      token = arg.slice(8);
    } else if (arg === '-t' || arg === '--token') {
      token = args[++i];
    } else if (arg.startsWith('--file=')) {
      backend = StorageType.File;
      dir = arg.slice(7);
    } else if (arg === '--file') {
      backend = StorageType.File;
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        dir = args[++i];
      }
    } else if (arg.startsWith('--sqlite=')) {
      backend = StorageType.Sqlite;
      dir = arg.slice(9);
    } else if (arg === '--sqlite') {
      backend = StorageType.Sqlite;
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        dir = args[++i];
      }
    } else if (
      arg.startsWith('--mode=') ||
      arg === '--reset' ||
      arg === '--defaults' ||
      arg.startsWith('--create=') ||
      arg.startsWith('--read=') ||
      arg.startsWith('--update=') ||
      arg.startsWith('--delete=') ||
      arg.startsWith('--max-records=') ||
      arg.startsWith('--max-size=') ||
      arg.startsWith('--max-history=') ||
      arg.startsWith('--user=') ||
      arg.startsWith('--app=')
    ) {
      positionalArgs.push(arg);
    } else if (arg.startsWith('-')) {
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        `Unknown or invalid option: "${arg}"`,
      );
    } else {
      positionalArgs.push(arg);
    }
  }

  const command = positionalArgs[0] ?? 'serve';

  return {
    command,
    positionalArgs,
    backend,
    dir,
    host,
    port,
    token,
  };
}

function parseBackend(val: string): StorageType {
  const normalized = val.toLowerCase();
  if (normalized === 'memory') return StorageType.Memory;
  if (normalized === 'file') return StorageType.File;
  if (normalized === 'sqlite') return StorageType.Sqlite;
  throw new TetherServerError(
    TetherServerErrorCode.ConfigurationError,
    `Invalid backend: "${val}". Expected "sqlite", "file", or "memory"`,
  );
}
