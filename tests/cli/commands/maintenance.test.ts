import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-cli-maintenance-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    sqliteStorage = createBackend('sqlite', tmpDir);
    memoryStorage = createBackend('memory');
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
    await handleMaintenanceCommand(sqliteStorage, [
      'maintenance',
      'checkpoint',
    ]);
    expect(testLogger.hasMessage('Checkpoint completed successfully')).toBe(
      true,
    );

    await handleMaintenanceCommand(sqliteStorage, ['maintenance', 'vacuum']);
    expect(testLogger.hasMessage('Vacuum completed successfully')).toBe(true);
  });

  it('should run prune on sqlite and memory storage', async () => {
    await handleMaintenanceCommand(sqliteStorage, [
      'maintenance',
      'prune',
      undefined as unknown as string,
      '100',
    ]);
    expect(testLogger.hasMessage('Prune completed successfully')).toBe(true);

    await handleMaintenanceCommand(memoryStorage, ['maintenance', 'prune']);
    expect(testLogger.hasMessage('Prune completed successfully')).toBe(true);
  });

  it('should throw NotSupported for checkpoint and vacuum on memory storage', async () => {
    await expect(
      handleMaintenanceCommand(memoryStorage, ['maintenance', 'checkpoint']),
    ).rejects.toThrow(/not supported/i);

    await expect(
      handleMaintenanceCommand(memoryStorage, ['maintenance', 'vacuum']),
    ).rejects.toThrow(/not supported/i);
  });

  it('should validate missing action and unknown action errors', async () => {
    await expect(
      handleMaintenanceCommand(sqliteStorage, ['maintenance']),
    ).rejects.toThrow(TetherServerError);

    await expect(
      handleMaintenanceCommand(sqliteStorage, [
        'maintenance',
        'invalid-action',
      ]),
    ).rejects.toThrow(TetherServerError);

    try {
      await handleMaintenanceCommand(sqliteStorage, [
        'maintenance',
        'invalid-action',
      ]);
    } catch (err) {
      expect((err as TetherServerError).code).toBe(
        TetherServerErrorCode.InvalidInput,
      );
    }
  });

  it('should reject invalid or malicious appId and handle non-existent apps', async () => {
    // Path traversal in appId
    await expect(
      handleMaintenanceCommand(sqliteStorage, [
        'maintenance',
        'checkpoint',
        '../../etc/passwd',
      ]),
    ).rejects.toThrow(TetherServerError);

    // Non-existent app
    await expect(
      handleMaintenanceCommand(sqliteStorage, [
        'maintenance',
        'checkpoint',
        'nonexistent_app_123',
      ]),
    ).rejects.toThrow(/not found/i);

    await expect(
      handleMaintenanceCommand(sqliteStorage, [
        'maintenance',
        'prune',
        'nonexistent_app_123',
      ]),
    ).rejects.toThrow(/not found/i);
  });
});
