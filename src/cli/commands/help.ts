import { getBanner } from '../banner.js';

/**
 * Displays command-line interface usage instructions.
 */
export function printHelp(): void {
  console.log(`
${getBanner()}

TetherDB CLI

Usage:
  npx tetherdb [command] [options]
  tetherdb [command] [options]

Commands:
  serve (default)                              Start HTTP and WebSocket synchronization server
  status                                       Display storage and database statistics
  stop                                         Stop the running TetherDB server
  maintenance checkpoint [table]               Truncate WAL files for SQLite databases
  maintenance vacuum                           Reclaim disk space and defragment database files
  maintenance prune [table] [keepCount]        Prune changelogs older than retention threshold
  migrate [--app=<appId>]                      Migrate offline database from v1 (multi-app) to v2 format
  tables [list]                                List all tables
  tables add <table_name> [options]            Create a table (--mode=..., --read=..., --max-records=...)
  tables show <table_name>                     Show table details and settings
  tables update <table_name> [options]         Update table settings (--mode=..., --reset, ...)
  tables rm <table_name>                       Delete a table and its data
  records list <table_name> [--user=id]        List records in a table
  records put <table_name> <id> <data>         Put/update a record in a table
  records rm <table_name> <id>                 Delete a record from a table
  users [list]                                 List all registered user accounts
  users add <username> <password>              Register a new user account
  users rm <userid>                            Delete a user account and associated data

Server Options (for 'serve'):
  -p, --port <number>                          Port number to bind (default: 8080 or PORT env)
  -H, --host <string>                          Host address to bind (default: 0.0.0.0 or HOST env)

Backend Options (for all commands):
  -b, --backend <sqlite|file|memory>           Storage backend engine (default: memory)
  -d, --dir <directory>                        Storage data directory (default: .data)
  -t, --token <token>                          Admin connection token for remote/memory server
  --sqlite[=<dir>]                             Shorthand for --backend sqlite --dir <dir>
  --file[=<dir>]                               Shorthand for --backend file --dir <dir>
  --memory[=<token>]                           Shorthand for --backend memory [--token <token>]
  -h, --help                                   Show this help message
`);
}
