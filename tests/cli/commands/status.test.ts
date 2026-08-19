import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackend } from '../../../src/cli/backend.js';
import { handleStatusCommand } from '../../../src/cli/commands/status.js';
import type { Storage } from '../../../src/server/index.js';

describe('handleStatusCommand', () => {
  let tmpDir: string;
  let storage: Storage;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-cli-status-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    storage = createBackend('sqlite', tmpDir);
  });

  afterEach(async () => {
    await storage.close?.();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should display status for empty database', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleStatusCommand(storage, ['status']);

    expect(logSpy).toHaveBeenCalledWith('TetherDB Storage Status:');
    expect(logSpy).toHaveBeenCalledWith('  Backend:     sqlite');
    expect(logSpy).toHaveBeenCalledWith('  Users:       0');
    expect(logSpy).toHaveBeenCalledWith('  Total Apps:  0');
    logSpy.mockRestore();
  });

  it('should display status for specific app with tables', async () => {
    const app = await storage.createApp('demo-app');
    await app.createTable('tasks');
    await app.createTable('settings');

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleStatusCommand(storage, ['status', 'demo-app']);

    expect(logSpy).toHaveBeenCalledWith('TetherDB Storage Status:');
    expect(logSpy).toHaveBeenCalledWith('  - App: demo-app');
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Tables \(2\): (settings, tasks|tasks, settings)/),
    );
    logSpy.mockRestore();
  });
});
