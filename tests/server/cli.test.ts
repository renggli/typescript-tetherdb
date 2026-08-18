import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BackendType,
  createBackend,
  handleServeCommand,
  runCli,
} from '../../src/server/cli.js';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../src/server/errors.js';
import {
  FileStorage,
  MemoryStorage,
  SqliteStorage,
} from '../../src/server/storage/index.js';

describe('CLI', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-cli-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  describe('createBackend', () => {
    it('should create matching in-memory storage by default', () => {
      const storage = createBackend();
      expect(storage).toBeInstanceOf(MemoryStorage);

      const explicitMem = createBackend('memory');
      expect(explicitMem).toBeInstanceOf(MemoryStorage);
    });

    it('should create matching SQLite storage with shared baseDir', () => {
      const storage = createBackend('sqlite', tmpDir);
      expect(storage).toBeInstanceOf(SqliteStorage);
    });

    it('should create matching file storage with shared baseDir', () => {
      const storage = createBackend('file', tmpDir);
      expect(storage).toBeInstanceOf(FileStorage);
    });

    it('should pass custom options through createBackend', () => {
      const storage = createBackend('memory', '.data', {
        maxRecordsPerTable: 500,
      });
      expect(storage).toBeInstanceOf(MemoryStorage);
    });

    it('should throw an error for unsupported backend types', () => {
      expect(() =>
        createBackend('unknown_backend' as unknown as BackendType),
      ).toThrow(TetherServerError);
      try {
        createBackend('unknown_backend' as unknown as BackendType);
      } catch (err) {
        expect((err as TetherServerError).code).toBe(
          TetherServerErrorCode.ConfigurationError,
        );
      }
    });
  });

  describe('handleServeCommand', () => {
    it('should launch server and log formatted endpoints', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const storage = createBackend('memory');
      const running = await handleServeCommand(
        storage,
        'memory',
        '.data',
        0,
        '127.0.0.1',
      );

      expect(running).toBeDefined();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'TetherDB server listening at: http://127.0.0.1:',
        ),
      );
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('WebSocket sync endpoint: ws://127.0.0.1:'),
      );
      expect(logSpy).toHaveBeenCalledWith(
        'Storage backend: in-memory (ephemeral)',
      );

      await running.close();
      await storage.close?.();
      logSpy.mockRestore();
    });

    it('should invoke runCli with serve command and handle shutdown signal', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as unknown as (
          code?: string | number | null | undefined,
        ) => never);

      await runCli([
        'serve',
        '--port=0',
        '--host=127.0.0.1',
        `--sqlite=${tmpDir}`,
      ]);

      // Emit shutdown signal
      process.emit('SIGINT');
      await new Promise((r) => setTimeout(r, 50));

      expect(logSpy).toHaveBeenCalledWith('Stopping TetherDB server...');
      expect(exitSpy).toHaveBeenCalledWith(0);

      logSpy.mockRestore();
      exitSpy.mockRestore();
    });
  });

  describe('CLI Subcommands', () => {
    it('should show help message with --help flag', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await runCli(['--help']);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('TetherDB CLI'),
      );
      logSpy.mockRestore();
    });

    it('should support users add, list, and rm subcommands on SQLite backend', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Add user via CLI without password (should fail)
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as unknown as (
          code?: string | number | null | undefined,
        ) => never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await runCli(['users', 'add', 'bob', `--sqlite=${tmpDir}`]);
      expect(errorSpy).toHaveBeenCalledWith(
        'Command failed:',
        'Missing password.',
      );
      exitSpy.mockRestore();
      errorSpy.mockRestore();

      // Add user via CLI with password
      await runCli([
        'users',
        'add',
        'alice',
        'password123',
        `--sqlite=${tmpDir}`,
      ]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Created user: ['),
      );

      // List users
      await runCli(['users', 'list', `--sqlite=${tmpDir}`]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Registered users (1):'),
      );

      // Extract created user ID from storage to test rm
      const storage = createBackend('sqlite', tmpDir);
      const user = await storage.getUserByUsername('alice');
      await storage.close?.();
      expect(user).toBeDefined();

      // Remove user
      await runCli(['users', 'rm', user?.id ?? '', `--sqlite=${tmpDir}`]);
      expect(logSpy).toHaveBeenCalledWith(`Deleted user: ${user?.id}`);

      // List again (empty)
      await runCli(['users', `--sqlite=${tmpDir}`]);
      expect(logSpy).toHaveBeenCalledWith('No registered users found.');

      // Test leading flags: --sqlite users (without =), should not swallow subcommand
      await runCli(['--sqlite', 'users']);
      expect(logSpy).toHaveBeenCalledWith('No registered users found.');

      // Test leading flags: --file users add
      await runCli(['--file', 'users']);
      expect(logSpy).toHaveBeenCalledWith('No registered users found.');

      logSpy.mockRestore();
    });

    it('should support apps and tables add/list/rm subcommands on SQLite and File backends', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as unknown as (
          code?: string | number | null | undefined,
        ) => never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // 0. Trying to add tables to non-existent app should fail
      await runCli([
        'tables',
        'add',
        'rezeptario',
        'recipes',
        `--sqlite=${tmpDir}`,
      ]);
      expect(errorSpy).toHaveBeenCalledWith(
        'Command failed:',
        'Application "rezeptario" not found.',
      );
      exitSpy.mockRestore();
      errorSpy.mockRestore();

      // 1. Add app "rezeptario"
      await runCli(['apps', 'add', 'rezeptario', `--sqlite=${tmpDir}`]);
      expect(logSpy).toHaveBeenCalledWith('Created application: rezeptario');

      // 2. Add tables "recipes" and "ingredients"
      await runCli([
        'tables',
        'add',
        'rezeptario',
        'recipes',
        'ingredients',
        `--sqlite=${tmpDir}`,
      ]);
      expect(logSpy).toHaveBeenCalledWith(
        'Added table "recipes" to application "rezeptario"',
      );
      expect(logSpy).toHaveBeenCalledWith(
        'Added table "ingredients" to application "rezeptario"',
      );

      // 3. List tables
      await runCli(['tables', 'list', 'rezeptario', `--sqlite=${tmpDir}`]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Tables for application "rezeptario" (2):'),
      );

      // 4. Remove a table
      await runCli([
        'tables',
        'rm',
        'rezeptario',
        'ingredients',
        `--sqlite=${tmpDir}`,
      ]);
      expect(logSpy).toHaveBeenCalledWith(
        'Removed table "ingredients" from application "rezeptario"',
      );

      // 5. List apps
      await runCli(['apps', 'list', `--sqlite=${tmpDir}`]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('• rezeptario (tables: recipes)'),
      );

      // 6. Delete app
      await runCli(['apps', 'rm', 'rezeptario', `--sqlite=${tmpDir}`]);
      expect(logSpy).toHaveBeenCalledWith('Deleted application: rezeptario');

      logSpy.mockRestore();
    });

    it('should reject double-dash options with values that omit equal signs', async () => {
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as unknown as (
          code?: string | number | null | undefined,
        ) => never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await runCli(['--port', '8080']);
      expect(errorSpy).toHaveBeenCalledWith(
        'Command failed:',
        expect.stringContaining('Unknown or invalid option: "--port"'),
      );

      await runCli(['--host', '127.0.0.1']);
      expect(errorSpy).toHaveBeenCalledWith(
        'Command failed:',
        expect.stringContaining('Unknown or invalid option: "--host"'),
      );

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should reject tables command without appId', async () => {
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as unknown as (
          code?: string | number | null | undefined,
        ) => never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await runCli(['tables', 'list']);
      expect(errorSpy).toHaveBeenCalledWith(
        'Command failed:',
        'Missing application ID.',
      );

      exitSpy.mockRestore();
      errorSpy.mockRestore();
    });

    it('should support users command error handling and unknown subcommands', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exitSpy = vi
        .spyOn(process, 'exit')
        .mockImplementation((() => {}) as unknown as (
          code?: string | number | null | undefined,
        ) => never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Missing username on users add
      await runCli(['users', 'add', `--sqlite=${tmpDir}`]);
      expect(errorSpy).toHaveBeenCalledWith(
        'Command failed:',
        'Missing username.',
      );

      // Missing user ID on users rm
      await runCli(['users', 'rm', `--sqlite=${tmpDir}`]);
      expect(errorSpy).toHaveBeenCalledWith(
        'Command failed:',
        'Missing user ID.',
      );

      // Removing non-existent user
      await runCli(['users', 'rm', 'nonexistent_id', `--sqlite=${tmpDir}`]);
      expect(logSpy).toHaveBeenCalledWith('User not found: nonexistent_id');

      // Unknown users action
      await runCli(['users', 'invalid_action', `--sqlite=${tmpDir}`]);
      expect(errorSpy).toHaveBeenCalledWith(
        'Command failed:',
        'Unknown users action: "invalid_action".',
      );

      // Unknown apps action
      await runCli(['apps', 'invalid_apps_action', `--sqlite=${tmpDir}`]);
      expect(errorSpy).toHaveBeenCalledWith(
        'Command failed:',
        'Unknown apps action: "invalid_apps_action".',
      );

      // Unknown tables action
      await runCli(['tables', 'add', 'app1', `--sqlite=${tmpDir}`]);
      expect(errorSpy).toHaveBeenCalledWith(
        'Command failed:',
        'Missing table name.',
      );

      // Unknown root command
      await runCli(['unknown_cmd']);
      expect(errorSpy).toHaveBeenCalledWith(
        'Command failed:',
        'Unknown command: "unknown_cmd".',
      );

      // Help alias -h
      await runCli(['-h']);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('TetherDB CLI'),
      );

      exitSpy.mockRestore();
      errorSpy.mockRestore();
      logSpy.mockRestore();
    });
  });
});
