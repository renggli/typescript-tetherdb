import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackend } from '../../../src/cli/backend.js';
import { handleUsersCommand } from '../../../src/cli/commands/users.js';
import {
  LocalAdminTarget,
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/index.js';
import { testLogger } from '../../logger.js';

describe('handleUsersCommand', () => {
  let tmpDir: string;
  let storage: Storage;
  let target: LocalAdminTarget;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-cli-users-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
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

  it('should list registered users (empty and populated)', async () => {
    // Empty list
    await handleUsersCommand(target, ['users', 'list']);
    expect(testLogger.hasMessage('No registered users found.')).toBe(true);

    // Add a user directly
    const user = await storage.createUser('alice', 'secret-pass');

    // List users
    testLogger.clear();
    await handleUsersCommand(target, ['users', 'list']);
    expect(testLogger.hasMessage('Registered users (1):')).toBe(true);
    expect(testLogger.hasMessage(`[${user.id}] alice`)).toBe(true);
  });

  it('should add a new user account', async () => {
    await handleUsersCommand(target, ['users', 'add', 'bobby', 'password123']);
    expect(testLogger.hasMessage('Created user: [')).toBe(true);
    expect(testLogger.hasMessage('bobby')).toBe(true);

    const user = await storage.getUserByUsername('bobby');
    expect(user).toBeDefined();
  });

  it('should remove user and report not found when appropriate', async () => {
    const user = await storage.createUser('charlie', 'password123');

    // Delete existing user
    await handleUsersCommand(target, ['users', 'rm', user.id]);
    expect(testLogger.hasMessage(`Deleted user: ${user.id}`)).toBe(true);
    expect(await storage.getUser(user.id)).toBeUndefined();

    // Delete non-existent user
    await expect(
      handleUsersCommand(target, ['users', 'rm', 'nonexistent_id']),
    ).rejects.toThrow(TetherServerError);
  });

  it('should throw error for missing arguments or invalid action', async () => {
    // Missing username on add
    await expect(handleUsersCommand(target, ['users', 'add'])).rejects.toThrow(
      TetherServerError,
    );

    // Missing password on add
    await expect(
      handleUsersCommand(target, ['users', 'add', 'dave']),
    ).rejects.toThrow(TetherServerError);

    // Missing user ID on rm
    await expect(handleUsersCommand(target, ['users', 'rm'])).rejects.toThrow(
      TetherServerError,
    );

    // Unknown action
    await expect(
      handleUsersCommand(target, ['users', 'invalid_action']),
    ).rejects.toThrow(TetherServerError);
    try {
      await handleUsersCommand(target, ['users', 'invalid_action']);
    } catch (err) {
      expect((err as TetherServerError).code).toBe(
        TetherServerErrorCode.ConfigurationError,
      );
      expect((err as Error).message).toContain(
        'Unknown users action: "invalid_action"',
      );
    }
  });
});
