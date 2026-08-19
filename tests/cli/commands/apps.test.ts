import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackend } from '../../../src/cli/backend.js';
import { handleAppsCommand } from '../../../src/cli/commands/apps.js';
import {
  type Storage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/index.js';

describe('handleAppsCommand', () => {
  let tmpDir: string;
  let storage: Storage;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-cli-apps-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
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

  it('should list empty applications', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleAppsCommand(storage, ['apps', 'list']);
    expect(logSpy).toHaveBeenCalledWith('No applications found.');
    logSpy.mockRestore();
  });

  it('should add application and list it with tables', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Add app
    await handleAppsCommand(storage, ['apps', 'add', 'todo-app']);
    expect(logSpy).toHaveBeenCalledWith('Created application: todo-app');

    // Add existing app (idempotency check)
    await handleAppsCommand(storage, ['apps', 'add', 'todo-app']);
    expect(logSpy).toHaveBeenCalledWith('Application already exists: todo-app');

    // Create a table on it
    const app = await storage.getApp('todo-app');
    await app?.createTable('todos');

    // List apps
    await handleAppsCommand(storage, ['apps', 'list']);
    expect(logSpy).toHaveBeenCalledWith('Applications (1):');
    expect(logSpy).toHaveBeenCalledWith('  • todo-app (tables: todos)');

    logSpy.mockRestore();
  });

  it('should remove application and handle non-existent app deletion', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleAppsCommand(storage, ['apps', 'add', 'todo-app']);
    expect(await storage.getApp('todo-app')).toBeDefined();

    // Delete app
    await handleAppsCommand(storage, ['apps', 'rm', 'todo-app']);
    expect(logSpy).toHaveBeenCalledWith('Deleted application: todo-app');
    expect(await storage.getApp('todo-app')).toBeUndefined();

    // Delete non-existent app
    await handleAppsCommand(storage, ['apps', 'rm', 'nonexistent']);
    expect(logSpy).toHaveBeenCalledWith('Application not found: nonexistent');

    logSpy.mockRestore();
  });

  it('should validate missing appId and unknown action errors', async () => {
    // Missing appId for add
    await expect(handleAppsCommand(storage, ['apps', 'add'])).rejects.toThrow(
      TetherServerError,
    );

    // Missing appId for rm
    await expect(handleAppsCommand(storage, ['apps', 'rm'])).rejects.toThrow(
      TetherServerError,
    );

    // Unknown action
    await expect(
      handleAppsCommand(storage, ['apps', 'invalid-action']),
    ).rejects.toThrow(TetherServerError);
    try {
      await handleAppsCommand(storage, ['apps', 'invalid-action']);
    } catch (err) {
      expect((err as TetherServerError).code).toBe(
        TetherServerErrorCode.ConfigurationError,
      );
      expect((err as Error).message).toBe(
        'Unknown apps action: "invalid-action".',
      );
    }
  });
});
