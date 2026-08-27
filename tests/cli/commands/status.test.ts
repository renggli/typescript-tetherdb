import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackend } from '../../../src/cli/backend.js';
import { handleStatusCommand } from '../../../src/cli/commands/status.js';
import type { Storage } from '../../../src/server/index.js';
import { testLogger } from '../../logger.js';

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
    await handleStatusCommand(storage, ['status'], tmpDir);

    expect(testLogger.hasMessage('TetherDB Storage Status:')).toBe(true);
    expect(testLogger.hasMessage('Backend:     sqlite')).toBe(true);
    expect(testLogger.hasMessage('Server:      Stopped')).toBe(true);
    expect(testLogger.hasMessage('Users:       0')).toBe(true);
    expect(testLogger.hasMessage('Tables:      0')).toBe(true);
  });

  it('should display status with tables', async () => {
    await storage.createTable('tasks');
    await storage.createTable('settings');

    await handleStatusCommand(storage, ['status'], tmpDir);

    expect(testLogger.hasMessage('TetherDB Storage Status:')).toBe(true);
    expect(testLogger.hasMessage('Server:      Stopped')).toBe(true);
    expect(testLogger.hasMessage('Tables:      2')).toBe(true);
    expect(testLogger.hasMessage('• tasks')).toBe(true);
    expect(testLogger.hasMessage('• settings')).toBe(true);
  });

  it('should display running server details when lock is present', async () => {
    const lockFile = path.join(tmpDir, 'server.lock');
    await fs.writeFile(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        port: 8080,
        host: '0.0.0.0',
        backend: 'sqlite',
        startedAt: Date.now(),
      }),
      { mode: 0o600 },
    );

    await handleStatusCommand(storage, ['status'], tmpDir);

    expect(testLogger.hasMessage(/Server:\s+Running \(PID:/)).toBe(true);
  });
});
