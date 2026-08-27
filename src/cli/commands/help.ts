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
  serve (default)                              Start HTTP and WebSocket synchronization server
  status                                       Display storage and database statistics
  stop                                         Stop the running TetherDB server
  maintenance checkpoint [table]               Truncate WAL files for SQLite databases
  maintenance vacuum                           Reclaim disk space and defragment database files
  maintenance prune [table] [keepCount]        Prune changelogs older than retention threshold
  tables [list]                                List all tables
  tables add <table_name> [options]            Create a table (--mode=..., --max-records=...)
  tables show <table_name>                     Show table details and settings
  tables update <table_name> [options]         Update table settings
  tables rm <table_name>                       Delete a table and its data
  records list <table_name> [--user=id]        List records in a table
  records put <table_name> <id> <data>         Put/update a record in a table
  records rm <table_name> <id>                 Delete a record from a table
  users [list]                                 List all registered user accounts
  users add <username> <password>              Register a new user account
  users rm <userid>                            Delete a user account and associated data

Server Options (for 'serve'):
  --port=<number>, -p <number>                 Port number to bind (default: 8080 or PORT env)
  --host=<string>, -H <string>                 Host address to bind (default: 0.0.0.0 or HOST env)

Backend Options (for all commands):
  --memory                                     Run in-memory without disk persistence (default)
  --file[=<dir>]                               Use filesystem directory for auth and data (default: .data)
  --sqlite[=<dir>]                             Use SQLite databases for auth and data (default: .data)
  --help, -h                                   Show this help message
`);
}
