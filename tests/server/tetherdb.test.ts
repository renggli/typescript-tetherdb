import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileStorage,
  MemoryStorage,
  SqliteStorage,
} from '../../src/server/storage/index.js';
import {
  type BackendType,
  createBackend,
  runCli,
} from '../../src/server/tetherdb.js';

describe('src/server/tetherdb.ts (CLI commands and backends)', () => {
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

    it('should pass custom limits through createBackend', () => {
      const storage = createBackend('memory', '.data', {
        maxTablesPerUser: 5,
      });
      expect(storage).toBeInstanceOf(MemoryStorage);
    });

    it('should throw an error for unsupported backend types', () => {
      expect(() =>
        createBackend('unknown_backend' as unknown as BackendType),
      ).toThrow('Unknown backend type');
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

    it('should support users list and users rm subcommands on SQLite backend', async () => {
      const storage = createBackend('sqlite', tmpDir);
      const user = await storage.createUser('alice', 'password123');
      await storage.close?.();

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // List users
      await runCli(['users', 'list', `--sqlite=${tmpDir}`]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Registered users (1):'),
      );

      // Remove user
      await runCli(['users', 'rm', user.id, `--sqlite=${tmpDir}`]);
      expect(logSpy).toHaveBeenCalledWith(`Deleted user: ${user.id}`);

      // List again (empty)
      await runCli(['users', `--sqlite=${tmpDir}`]);
      expect(logSpy).toHaveBeenCalledWith('No registered users found.');

      logSpy.mockRestore();
    });

    it('should support apps and tables add/list/rm subcommands on SQLite and File backends', async () => {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

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
  });
});
