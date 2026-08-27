import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackend } from '../../../src/cli/backend.js';
import { handleTablesCommand } from '../../../src/cli/commands/tables.js';
import {
  LocalAdminTarget,
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/index.js';
import { testLogger } from '../../logger.js';

describe('handleTablesCommand', () => {
  let tmpDir: string;
  let storage: Storage;
  let target: LocalAdminTarget;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-cli-tables-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    storage = createBackend('sqlite', tmpDir);
    target = new LocalAdminTarget(storage);
  });

  afterEach(async () => {
    await storage.close?.();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('should list tables (empty and populated)', async () => {
    // List empty
    await handleTablesCommand(target, ['tables', 'list']);
    expect(testLogger.hasMessage('No tables found.')).toBe(true);

    // Create tables
    await storage.createTable('recipes');
    await storage.createTable('ingredients');

    // List again
    testLogger.clear();
    await handleTablesCommand(target, ['tables', 'list']);
    expect(testLogger.hasMessage('Tables (2):')).toBe(true);
    expect(testLogger.hasMessage('• recipes')).toBe(true);
    expect(testLogger.hasMessage('• ingredients')).toBe(true);
  });

  it('should add tables with custom settings', async () => {
    await handleTablesCommand(target, [
      'tables',
      'add',
      'recipes',
      '--read=everybody',
      '--max-records=500',
    ]);
    expect(testLogger.hasMessage('Created table "recipes"')).toBe(true);

    const table = await storage.getTable('recipes');
    expect(table).toBeDefined();
    expect(table?.settings.permissions?.read).toBe('everybody');
    expect(table?.settings.maxRecords).toBe(500);
  });

  it('should show table details', async () => {
    await storage.createTable('recipes', { maxRecords: 1000 });

    await handleTablesCommand(target, ['tables', 'show', 'recipes']);
    expect(testLogger.hasMessage('Table "recipes":')).toBe(true);
    expect(testLogger.hasMessage('Max Records:  1000')).toBe(true);
  });

  it('should update table settings', async () => {
    await storage.createTable('recipes', { maxRecords: 100 });

    await handleTablesCommand(target, [
      'tables',
      'update',
      'recipes',
      '--max-records=2000',
    ]);
    expect(testLogger.hasMessage('Updated table "recipes":')).toBe(true);

    const table = await storage.getTable('recipes');
    expect(table?.settings.maxRecords).toBe(2000);
  });

  it('should remove tables', async () => {
    await storage.createTable('recipes');

    // Remove existing table
    await handleTablesCommand(target, ['tables', 'rm', 'recipes']);
    expect(testLogger.hasMessage('Deleted table "recipes"')).toBe(true);
    expect(await storage.getTable('recipes')).toBeUndefined();
  });

  it('should throw error when table name is missing on add, show, update, rm', async () => {
    await expect(
      handleTablesCommand(target, ['tables', 'add']),
    ).rejects.toThrow(TetherServerError);

    await expect(
      handleTablesCommand(target, ['tables', 'show']),
    ).rejects.toThrow(TetherServerError);

    await expect(
      handleTablesCommand(target, ['tables', 'update']),
    ).rejects.toThrow(TetherServerError);

    await expect(handleTablesCommand(target, ['tables', 'rm'])).rejects.toThrow(
      TetherServerError,
    );

    // Unknown action
    await expect(
      handleTablesCommand(target, ['tables', 'invalid_action']),
    ).rejects.toThrow(TetherServerError);
    try {
      await handleTablesCommand(target, ['tables', 'invalid_action']);
    } catch (err) {
      expect((err as TetherServerError).code).toBe(
        TetherServerErrorCode.ConfigurationError,
      );
      expect((err as Error).message).toContain('Unknown tables action');
    }
  });
});
