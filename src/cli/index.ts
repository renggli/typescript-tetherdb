/**
 * TetherDB CLI — Command-line interface and administration tools.
 *
 * @module tetherdb/cli
 */

export { type ParsedCliArgs, parseCliArgs } from './args.js';
export { type BackendType, createBackend } from './backend.js';
export { runCli } from './cli.js';
export {
  handleAppsCommand,
  handleServeCommand,
  handleTablesCommand,
  handleUsersCommand,
  printHelp,
} from './commands/index.js';
