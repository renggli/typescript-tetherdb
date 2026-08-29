import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalAdminTarget } from '../../../src/cli/admin.js';
import { createBackend } from '../../../src/cli/backend.js';
import { handleMaintenanceCommand } from '../../../src/cli/commands/maintenance.js';
import {
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/index.js';
import { testLogger } from '../../logger.js';

describe('handleMaintenanceCommand', () => {
  let tmpDir: string;
  let sqliteStorage: Storage;
  let memoryStorage: Storage;
  let sqliteTarget: LocalAdminTarget;
  let memoryTarget: LocalAdminTarget;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-cli-maintenance-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    sqliteStorage = createBackend('sqlite', tmpDir);
    memoryStorage = createBackend('memory');
    sqliteTarget = new LocalAdminTarget(sqliteStorage);
    memoryTarget = new LocalAdminTarget(memoryStorage);
  });

  afterEach(async () => {
    await sqliteStorage.close?.();
    await memoryStorage.close?.();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should run checkpoint and vacuum on sqlite storage', async () => {
    await handleMaintenanceCommand(sqliteTarget, ['maintenance', 'checkpoint']);
    expect(testLogger.hasMessage('Checkpoint completed successfully')).toBe(
      true,
    );

    await handleMaintenanceCommand(sqliteTarget, ['maintenance', 'vacuum']);
    expect(testLogger.hasMessage('Vacuum completed successfully')).toBe(true);
  });

  it('should run prune on sqlite and memory storage', async () => {
    await handleMaintenanceCommand(sqliteTarget, [
      'maintenance',
      'prune',
      undefined as unknown as string,
      '100',
    ]);
    expect(testLogger.hasMessage('Prune completed successfully')).toBe(true);

    await handleMaintenanceCommand(memoryTarget, ['maintenance', 'prune']);
    expect(testLogger.hasMessage('Prune completed successfully')).toBe(true);
  });

  it('should throw NotSupported for checkpoint and vacuum on memory storage', async () => {
    await expect(
      handleMaintenanceCommand(memoryTarget, ['maintenance', 'checkpoint']),
    ).rejects.toThrow(/not supported/i);

    await expect(
      handleMaintenanceCommand(memoryTarget, ['maintenance', 'vacuum']),
    ).rejects.toThrow(/not supported/i);
  });

  it('should validate missing action and unknown action errors', async () => {
    await expect(
      handleMaintenanceCommand(sqliteTarget, ['maintenance']),
    ).rejects.toThrow(TetherServerError);

    await expect(
      handleMaintenanceCommand(sqliteTarget, ['maintenance', 'invalid-action']),
    ).rejects.toThrow(TetherServerError);

    try {
      await handleMaintenanceCommand(sqliteTarget, [
        'maintenance',
        'invalid-action',
      ]);
    } catch (err) {
      expect((err as TetherServerError).code).toBe(
        TetherServerErrorCode.InvalidInput,
      );
    }
  });

  it('should support optional table parameter for checkpoint and prune', async () => {
    await sqliteStorage.createTable('tasks');
    await handleMaintenanceCommand(sqliteTarget, [
      'maintenance',
      'checkpoint',
      'tasks',
    ]);
    expect(testLogger.hasMessage('Checkpoint completed successfully')).toBe(
      true,
    );

    await handleMaintenanceCommand(sqliteTarget, [
      'maintenance',
      'prune',
      'tasks',
      '50',
    ]);
    expect(testLogger.hasMessage('Prune completed successfully')).toBe(true);
  });
});
