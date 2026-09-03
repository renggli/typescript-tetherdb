import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalAdminTarget } from '../../../src/cli/admin.js';
import { createBackend } from '../../../src/cli/backend.js';
import { handleRecordsCommand } from '../../../src/cli/commands/records.js';
import {
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

  it('should handle missing table error when no table name is passed and put with empty payload', async () => {
    await expect(handleRecordsCommand(target, ['records'])).rejects.toThrow(
      TetherServerError,
    );
    await handleRecordsCommand(target, [
      'records',
      'put',
      'tasks',
      'empty-record',
    ]);
    expect(
      testLogger.hasMessage('Put record "empty-record" in table "tasks"'),
    ).toBe(true);
  });

  it('bypasses permissions by default as admin and enforces permissions with --user flag', async () => {
    // Create locked-down table: nobody can create or read normally
    await storage.createTable('locked_table', {
      permissions: {
        create: 'nobody',
        read: 'nobody',
        update: 'nobody',
        delete: 'nobody',
      },
    });

    await storage.createUser('alice', 'password123');

    // 1. Default admin execution succeeds even when table policy is 'nobody'
    testLogger.clear();
    await handleRecordsCommand(target, [
      'records',
      'put',
      'locked_table',
      'admin-rec',
      '{"system":true}',
    ]);
    expect(
      testLogger.hasMessage('Put record "admin-rec" in table "locked_table"'),
    ).toBe(true);

    testLogger.clear();
    await handleRecordsCommand(target, ['records', 'list', 'locked_table']);
    expect(testLogger.hasMessage('Records in "locked_table" (1):')).toBe(true);

    // 2. Executing with --user=alice enforces permissions and rejects create
    await expect(
      handleRecordsCommand(target, [
        'records',
        'put',
        'locked_table',
        'alice-rec',
        '{"title":"Alice"}',
        '--user=alice',
      ]),
    ).rejects.toMatchObject({
      code: TetherServerErrorCode.Forbidden,
    });

    // 3. Executing with uncreated user names ('anonymous', 'guest', 'admin') throws NotFound
    await expect(
      handleRecordsCommand(target, [
        'records',
        'put',
        'locked_table',
        'guest-rec',
        '{"title":"Guest"}',
        '--user=anonymous',
      ]),
    ).rejects.toMatchObject({
      code: TetherServerErrorCode.NotFound,
    });

    await expect(
      handleRecordsCommand(target, [
        'records',
        'put',
        'locked_table',
        'guest-rec',
        '{"title":"Guest"}',
        '--user=guest',
      ]),
    ).rejects.toMatchObject({
      code: TetherServerErrorCode.NotFound,
    });

    await expect(
      handleRecordsCommand(target, [
        'records',
        'put',
        'locked_table',
        'admin-rec',
        '{"title":"Admin"}',
        '--user=admin',
      ]),
    ).rejects.toMatchObject({
      code: TetherServerErrorCode.NotFound,
    });

    // 4. Executing with unknown user throws NotFound
    await expect(
      handleRecordsCommand(target, [
        'records',
        'list',
        'locked_table',
        '--user=unknown_user',
      ]),
    ).rejects.toMatchObject({
      code: TetherServerErrorCode.NotFound,
    });

    // 5. If an actual user named 'admin' is registered, --user=admin resolves that user and enforces permissions
    await storage.createUser('admin', 'pass123');
    await expect(
      handleRecordsCommand(target, [
        'records',
        'put',
        'locked_table',
        'rec-by-admin-user',
        '{"title":"Admin User"}',
        '--user=admin',
      ]),
    ).rejects.toMatchObject({
      code: TetherServerErrorCode.Forbidden,
    });

    // 5. In user-partitioned (private) table, --user=alice writes and reads from Alice's partition
    await storage.createTable('private_notes', {
      permissions: {
        read: 'owner',
        create: 'authenticated',
        update: 'owner',
        delete: 'owner',
      },
    });

    await handleRecordsCommand(target, [
      'records',
      'put',
      'private_notes',
      'note-1',
      '{"text":"Secret"}',
      '--user=alice',
    ]);

    testLogger.clear();
    await handleRecordsCommand(target, [
      'records',
      'list',
      'private_notes',
      '--user=alice',
    ]);
    expect(testLogger.hasMessage('Records in "private_notes" (1):')).toBe(true);
    expect(testLogger.hasMessage('Secret')).toBe(true);

    // Bob cannot read Alice's private notes
    await storage.createUser('bob', 'password123');
    testLogger.clear();
    await handleRecordsCommand(target, [
      'records',
      'list',
      'private_notes',
      '--user=bob',
    ]);
    expect(
      testLogger.hasMessage('No records found in table "private_notes"'),
    ).toBe(true);
  });
});
