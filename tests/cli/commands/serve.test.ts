import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackend } from '../../../src/cli/backend.js';
import { handleServeCommand } from '../../../src/cli/commands/serve.js';
import { testLogger } from '../../logger.js';

describe('handleServeCommand', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-serve-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should launch server and log formatted endpoints', async () => {
    const storage = createBackend('memory');
    const running = await handleServeCommand(
      storage,
      'memory',
      tmpDir,
      0,
      '127.0.0.1',
    );

    expect(running).toBeDefined();
    expect(testLogger.hasMessage('HTTP API:')).toBe(true);
    expect(testLogger.hasMessage('WebSocket:')).toBe(true);
    expect(testLogger.hasMessage('Storage:')).toBe(true);
    expect(testLogger.hasMessage('Admin Token:')).toBe(true);

    await running.close();
    await storage.close?.();
  });

  it('should format storage backend path for file/sqlite backends', async () => {
    const storage = createBackend('memory');
    const running = await handleServeCommand(
      storage,
      'sqlite',
      '/tmp/test-db',
      0,
      '0.0.0.0',
    );

    expect(running).toBeDefined();
    expect(testLogger.hasMessage('HTTP API:')).toBe(true);
    expect(testLogger.hasMessage('sqlite (/tmp/test-db)')).toBe(true);

    await running.close();
    await storage.close?.();
  });
});
