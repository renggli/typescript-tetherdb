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
  status [appid]                          Display storage and database statistics
  maintenance checkpoint [appid]          Truncate WAL files for SQLite databases
  maintenance vacuum [appid]              Reclaim disk space and defragment database files
  maintenance prune [appid] [keepCount]   Prune changelogs older than retention threshold
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
