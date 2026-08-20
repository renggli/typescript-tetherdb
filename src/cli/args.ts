import { TetherServerError, TetherServerErrorCode } from '../server/index.js';
import type { BackendType } from './backend.js';

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
      throw new TetherServerError(
        TetherServerErrorCode.ConfigurationError,
        `Unknown or invalid option: "${arg}"`,
      );
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
