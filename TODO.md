# TODO

## Problem 1

When starting the forum example the `server.lock` is as follows:

```json
{
  "pid": 39719,
  "port": 3001,
  "host": "::1",
  "type": "file",
  "startedAt": 1788092166384,
  "adminSecret": "7643818290c59af938ba5da317cb422100f1f5460011ec10115c00230aea7b81"
}
```

This triggers the following error when trying to list the tables:

```bash
$ npx tetherdb --file=examples/forum/data tables
npm notice run tetherdb@0.1.1 npx
npm notice run 'tetherdb' --file=examples/forum/data tables
Command failed: Failed to connect to running server at http://::1:3001: Failed to parse URL from http://::1:3001/admin/tables
```

## Problem 2

When opening the same application in multiple browser tabs they conflict accessing and updating the same IndexedDB table. Design a solution for this problem.
