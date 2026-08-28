import { TetherServerError, TetherServerErrorCode } from '../server/errors.js';
import { BackendType } from '../server/storage/index.js';

/**
 * Parsed CLI arguments and configuration options.
 */
export interface ParsedCliArgs {
  command: string;
  positionalArgs: string[];
  backend: BackendType;
  dir: string;
  host: string;
  port: number;
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
  let backend: BackendType = BackendType.Memory;
  let dir = '.data';

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
    } else if (arg === '--memory') {
      backend = BackendType.Memory;
    } else if (arg.startsWith('--file=')) {
      backend = BackendType.File;
      dir = arg.slice(7);
    } else if (arg === '--file') {
      backend = BackendType.File;
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        dir = args[++i];
      }
    } else if (arg.startsWith('--sqlite=')) {
      backend = BackendType.Sqlite;
      dir = arg.slice(9);
    } else if (arg === '--sqlite') {
      backend = BackendType.Sqlite;
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        dir = args[++i];
      }
    } else if (
      arg.startsWith('--create=') ||
      arg.startsWith('--read=') ||
      arg.startsWith('--update=') ||
      arg.startsWith('--delete=') ||
      arg.startsWith('--max-records=') ||
      arg.startsWith('--max-size=') ||
      arg.startsWith('--max-history=') ||
      arg.startsWith('--user=')
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

  let command = positionalArgs[0] ?? 'serve';
  if (command === 'table') command = 'tables';
  else if (command === 'user') command = 'users';
  else if (command === 'record') command = 'records';

  if (positionalArgs.length > 0) {
    positionalArgs[0] = command;
  }

  return {
    command,
    positionalArgs,
    backend,
    dir,
    host,
    port,
  };
}

function parseBackend(val: string): BackendType {
  const normalized = val.toLowerCase();
  if (normalized === 'memory') return BackendType.Memory;
  if (normalized === 'file') return BackendType.File;
  if (normalized === 'sqlite') return BackendType.Sqlite;
  throw new TetherServerError(
    TetherServerErrorCode.ConfigurationError,
    `Invalid backend: "${val}". Expected "sqlite", "file", or "memory"`,
  );
}
