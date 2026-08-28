import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackend } from '../../../src/cli/backend.js';
import { handleRecordsCommand } from '../../../src/cli/commands/records.js';
import {
  LocalAdminTarget,
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/index.js';
import { testLogger } from '../../logger.js';

describe('handleRecordsCommand', () => {
  let tmpDir: string;
  let storage: Storage;
  let target: LocalAdminTarget;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-cli-records-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    storage = createBackend('sqlite', tmpDir);
    target = new LocalAdminTarget(storage);
    await storage.createTable('tasks', {
      permissions: {
        read: 'everybody',
        create: 'everybody',
        update: 'everybody',
        delete: 'everybody',
      },
    });
  });

  afterEach(async () => {
    await storage.close?.();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should list, put, and remove records in a table', async () => {
    // 1. List empty
    testLogger.clear();
    await handleRecordsCommand(target, ['records', 'list', 'tasks']);
    expect(testLogger.hasMessage('No records found in table "tasks"')).toBe(
      true,
    );

    // 2. Put JSON record
    testLogger.clear();
    await handleRecordsCommand(target, [
      'records',
      'put',
      'tasks',
      't1',
      '{"title":"Task One"}',
    ]);
    expect(testLogger.hasMessage('Put record "t1" in table "tasks"')).toBe(
      true,
    );

    // 3. Put primitive string record
    testLogger.clear();
    await handleRecordsCommand(target, [
      'records',
      'put',
      'tasks',
      't2',
      'Plain string payload',
    ]);
    expect(testLogger.hasMessage('Put record "t2" in table "tasks"')).toBe(
      true,
    );

    // 4. List records
    testLogger.clear();
    await handleRecordsCommand(target, ['records', 'list', 'tasks']);
    expect(testLogger.hasMessage('Records in "tasks" (2):')).toBe(true);
    expect(testLogger.hasMessage('Task One')).toBe(true);

    // 5. Delete record
    testLogger.clear();
    await handleRecordsCommand(target, ['records', 'rm', 'tasks', 't1']);
    expect(
      testLogger.hasMessage('Deleted record "t1" from table "tasks"'),
    ).toBe(true);

    // 6. Verify list after delete
    testLogger.clear();
    await handleRecordsCommand(target, ['records', 'list', 'tasks']);
    expect(testLogger.hasMessage('Records in "tasks" (1):')).toBe(true);
  });

  it('should support --user option for user-partitioned operations', async () => {
    const user = await storage.createUser('testuser', 'password123');

    await handleRecordsCommand(target, [
      'records',
      'put',
      'tasks',
      'u-task-1',
      '{"userOnly":true}',
      `--user=${user.userId}`,
    ]);
    expect(
      testLogger.hasMessage('Put record "u-task-1" in table "tasks"'),
    ).toBe(true);

    testLogger.clear();
    await handleRecordsCommand(target, [
      'records',
      'list',
      'tasks',
      `--user=${user.userId}`,
    ]);
    expect(testLogger.hasMessage('Records in "tasks" (1):')).toBe(true);
    expect(testLogger.hasMessage('userOnly')).toBe(true);
  });

  it('should throw ConfigurationError for missing table or record arguments', async () => {
    await expect(
      handleRecordsCommand(target, ['records', 'list']),
    ).rejects.toThrow(TetherServerError);

    await expect(
      handleRecordsCommand(target, ['records', 'put', 'tasks']),
    ).rejects.toThrow(TetherServerError);

    await expect(
      handleRecordsCommand(target, ['records', 'rm', 'tasks']),
    ).rejects.toThrow(TetherServerError);

    await expect(
      handleRecordsCommand(target, ['records', 'invalid', 'tasks']),
    ).rejects.toThrow(TetherServerError);

    try {
      await handleRecordsCommand(target, ['records', 'invalid', 'tasks']);
    } catch (err) {
      expect((err as TetherServerError).code).toBe(
        TetherServerErrorCode.ConfigurationError,
      );
    }
  });
});
