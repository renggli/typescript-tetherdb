import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalAdminTarget } from '../../../src/cli/admin.js';
import { createBackend } from '../../../src/cli/backend.js';
import { handleTablesCommand } from '../../../src/cli/commands/tables.js';
import {
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/index.js';
import { Permission } from '../../../src/shared/types.js';
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
    expect(testLogger.hasMessage('• recipes (user-private)')).toBe(true);
    expect(testLogger.hasMessage('• ingredients (user-private)')).toBe(true);
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
    expect(testLogger.hasMessage('Updated table "recipes"')).toBe(true);

    const table = await storage.getTable('recipes');
    expect(table?.settings.maxRecords).toBe(2000);
  });

  it('should reset permissions and limits to defaults', async () => {
    await storage.createTable('recipes', {
      permissions: { read: Permission.Everybody },
      maxRecords: 500,
    });

    // Reset single permission to default
    await handleTablesCommand(target, [
      'tables',
      'update',
      'recipes',
      '--read=default',
      '--max-records=default',
    ]);

    let table = await storage.getTable('recipes');
    expect(table?.settings.permissions?.read).toBe('owner');
    expect(table?.settings.maxRecords).toBeUndefined();

    // Re-set and full --reset
    await handleTablesCommand(target, [
      'tables',
      'update',
      'recipes',
      '--read=everybody',
      '--max-records=1000',
    ]);
    table = await storage.getTable('recipes');
    expect(table?.settings.permissions?.read).toBe('everybody');
    expect(table?.settings.maxRecords).toBe(1000);

    await handleTablesCommand(target, [
      'tables',
      'update',
      'recipes',
      '--reset',
    ]);
    table = await storage.getTable('recipes');
    expect(table?.settings.permissions?.read).toBe('owner');
    expect(table?.settings.permissions?.create).toBe('authenticated');
    expect(table?.settings.maxRecords).toBeUndefined();
  });

  it('should support permission mode presets via --mode', async () => {
    await handleTablesCommand(target, [
      'tables',
      'add',
      'forum',
      '--mode=public-read',
    ]);
    let table = await storage.getTable('forum');
    expect(table?.settings.permissions?.read).toBe('everybody');
    expect(table?.settings.permissions?.create).toBe('authenticated');
    expect(table?.settings.permissions?.update).toBe('owner');
    expect(table?.settings.permissions?.delete).toBe('owner');

    await handleTablesCommand(target, [
      'tables',
      'update',
      'forum',
      '--mode=shared',
    ]);
    table = await storage.getTable('forum');
    expect(table?.settings.permissions?.read).toBe('authenticated');
    expect(table?.settings.permissions?.create).toBe('authenticated');
    expect(table?.settings.permissions?.update).toBe('owner');
    expect(table?.settings.permissions?.delete).toBe('owner');
  });

  it('should remove tables', async () => {
    await storage.createTable('recipes');

    // Remove existing table
    await handleTablesCommand(target, ['tables', 'rm', 'recipes']);
    expect(testLogger.hasMessage('Deleted table "recipes"')).toBe(true);
    expect(await storage.getTable('recipes')).toBeUndefined();
  });

  it('should parse all permission and resource limit options', async () => {
    await handleTablesCommand(target, [
      'tables',
      'add',
      'complex',
      '--create=authenticated',
      '--read=everybody',
      '--update=owner',
      '--delete=nobody',
      '--max-records=5000',
      '--max-size=1048576',
      '--max-history=50',
    ]);
    expect(testLogger.hasMessage('Created table "complex"')).toBe(true);

    testLogger.clear();
    await handleTablesCommand(target, ['tables', 'show', 'complex']);
    expect(testLogger.hasMessage('Max Size:     1048576 bytes')).toBe(true);
    expect(testLogger.hasMessage('Max History:  50')).toBe(true);
  });

  it('should throw error for invalid permission options', async () => {
    await expect(
      handleTablesCommand(target, [
        'tables',
        'add',
        'invalid_perm',
        '--read=invalid_value',
      ]),
    ).rejects.toThrow(TetherServerError);
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

  it('should validate invalid permission modes and invalid numeric limits', async () => {
    await expect(
      handleTablesCommand(target, [
        'tables',
        'add',
        'bad_mode',
        '--mode=nonexistent_mode',
      ]),
    ).rejects.toThrow(TetherServerError);
    await expect(
      handleTablesCommand(target, [
        'tables',
        'add',
        'bad_num',
        '--max-records=invalid',
      ]),
    ).rejects.toThrow(TetherServerError);
    await expect(
      handleTablesCommand(target, [
        'tables',
        'add',
        'bad_negative',
        '--max-size=-10',
      ]),
    ).rejects.toThrow(TetherServerError);
    await handleTablesCommand(target, [
      'tables',
      'add',
      'mode_aliases',
      '--mode=public',
      '--max-records=0',
      '--max-size=none',
      '--max-history=default',
    ]);
    const table = await storage.getTable('mode_aliases');
    expect(table).toBeDefined();
    testLogger.clear();
    await handleTablesCommand(target, ['tables']);
    expect(testLogger.hasMessage(/Tables \(/)).toBe(true);
  });
});
