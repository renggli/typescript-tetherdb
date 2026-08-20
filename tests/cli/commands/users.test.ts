import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackend } from '../../../src/cli/backend.js';
import { handleUsersCommand } from '../../../src/cli/commands/users.js';
import {
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/index.js';

describe('handleUsersCommand', () => {
  let tmpDir: string;
  let storage: Storage;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-cli-users-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
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

  it('should list registered users (empty and populated)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Empty list
    await handleUsersCommand(storage, ['users', 'list']);
    expect(logSpy).toHaveBeenCalledWith('No registered users found.');

    // Add a user directly
    const user = await storage.createUser('alice', 'secret-pass');

    // List users
    await handleUsersCommand(storage, ['users', 'list']);
    expect(logSpy).toHaveBeenCalledWith('Registered users (1):');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`[${user.id}] alice`),
    );

    logSpy.mockRestore();
  });

  it('should add a new user account', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleUsersCommand(storage, ['users', 'add', 'bobby', 'password123']);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Created user: ['),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('bobby'));

    const user = await storage.getUserByUsername('bobby');
    expect(user).toBeDefined();

    logSpy.mockRestore();
  });

  it('should remove user and report not found when appropriate', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const user = await storage.createUser('charlie', 'password123');

    // Delete existing user
    await handleUsersCommand(storage, ['users', 'rm', user.id]);
    expect(logSpy).toHaveBeenCalledWith(`Deleted user: ${user.id}`);
    expect(await storage.getUser(user.id)).toBeUndefined();

    // Delete non-existent user
    await handleUsersCommand(storage, ['users', 'rm', 'nonexistent_id']);
    expect(logSpy).toHaveBeenCalledWith('User not found: nonexistent_id');

    logSpy.mockRestore();
  });

  it('should throw error for missing arguments or invalid action', async () => {
    // Missing username on add
    await expect(handleUsersCommand(storage, ['users', 'add'])).rejects.toThrow(
      TetherServerError,
    );

    // Missing password on add
    await expect(
      handleUsersCommand(storage, ['users', 'add', 'dave']),
    ).rejects.toThrow(TetherServerError);

    // Missing user ID on rm
    await expect(handleUsersCommand(storage, ['users', 'rm'])).rejects.toThrow(
      TetherServerError,
    );

    // Unknown action
    await expect(
      handleUsersCommand(storage, ['users', 'invalid_action']),
    ).rejects.toThrow(TetherServerError);
    try {
      await handleUsersCommand(storage, ['users', 'invalid_action']);
    } catch (err) {
      expect((err as TetherServerError).code).toBe(
        TetherServerErrorCode.ConfigurationError,
      );
      expect((err as Error).message).toBe(
        'Unknown users action: "invalid_action"',
      );
    }
  });
});
