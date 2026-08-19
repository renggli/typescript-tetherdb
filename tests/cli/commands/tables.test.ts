import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackend } from '../../../src/cli/backend.js';
import { handleTablesCommand } from '../../../src/cli/commands/tables.js';
import {
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/index.js';

describe('handleTablesCommand', () => {
  let tmpDir: string;
  let storage: Storage;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-cli-tables-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    storage = createBackend('sqlite', tmpDir);
  });

  afterEach(async () => {
    await storage.close?.();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('should list tables for an application (empty and populated)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await storage.createApp('rezeptario');

    // List empty
    await handleTablesCommand(storage, ['tables', 'list', 'rezeptario']);
    expect(logSpy).toHaveBeenCalledWith(
      'No tables found for application "rezeptario".',
    );

    // List with direct app name shorthand: tables <appid>
    await handleTablesCommand(storage, ['tables', 'rezeptario']);
    expect(logSpy).toHaveBeenCalledWith(
      'No tables found for application "rezeptario".',
    );

    // Add tables via API
    const app = await storage.getApp('rezeptario');
    await app?.createTable('recipes');
    await app?.createTable('ingredients');

    // List again
    await handleTablesCommand(storage, ['tables', 'list', 'rezeptario']);
    expect(logSpy).toHaveBeenCalledWith(
      'Tables for application "rezeptario" (2):',
    );
    expect(logSpy).toHaveBeenCalledWith('  • recipes');
    expect(logSpy).toHaveBeenCalledWith('  • ingredients');

    logSpy.mockRestore();
  });

  it('should add multiple tables to an application', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await storage.createApp('rezeptario');

    await handleTablesCommand(storage, [
      'tables',
      'add',
      'rezeptario',
      'recipes',
      'ingredients',
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      'Added table "recipes" to application "rezeptario"',
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Added table "ingredients" to application "rezeptario"',
    );

    // Add existing table (idempotency check)
    await handleTablesCommand(storage, [
      'tables',
      'add',
      'rezeptario',
      'recipes',
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      'Table "recipes" already exists in application "rezeptario"',
    );

    logSpy.mockRestore();
  });

  it('should remove tables from an application', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const app = await storage.createApp('rezeptario');
    await app.createTable('recipes');

    // Remove existing table
    await handleTablesCommand(storage, [
      'tables',
      'rm',
      'rezeptario',
      'recipes',
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      'Removed table "recipes" from application "rezeptario"',
    );

    // Remove non-existent table
    await handleTablesCommand(storage, [
      'tables',
      'rm',
      'rezeptario',
      'nonexistent',
    ]);
    expect(logSpy).toHaveBeenCalledWith(
      'Table "nonexistent" not found in application "rezeptario"',
    );

    logSpy.mockRestore();
  });

  it('should throw error when application does not exist', async () => {
    await expect(
      handleTablesCommand(storage, ['tables', 'list', 'nonexistent']),
    ).rejects.toThrow(TetherServerError);

    await expect(
      handleTablesCommand(storage, ['tables', 'add', 'nonexistent', 'table1']),
    ).rejects.toThrow(TetherServerError);

    try {
      await handleTablesCommand(storage, [
        'tables',
        'add',
        'nonexistent',
        'table1',
      ]);
    } catch (err) {
      expect((err as TetherServerError).code).toBe(
        TetherServerErrorCode.NotFound,
      );
    }
  });

  it('should throw error when appId or table name are missing', async () => {
    // Missing appId on list
    await expect(
      handleTablesCommand(storage, ['tables', 'list']),
    ).rejects.toThrow(TetherServerError);

    // Missing appId on add
    await expect(
      handleTablesCommand(storage, ['tables', 'add']),
    ).rejects.toThrow(TetherServerError);

    // Missing table name on add
    await expect(
      handleTablesCommand(storage, ['tables', 'add', 'app1']),
    ).rejects.toThrow(TetherServerError);

    try {
      await handleTablesCommand(storage, ['tables', 'add', 'app1']);
    } catch (err) {
      expect((err as TetherServerError).code).toBe(
        TetherServerErrorCode.ConfigurationError,
      );
      expect((err as Error).message).toBe('Missing table name.');
    }
  });
});
