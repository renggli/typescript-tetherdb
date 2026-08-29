import { describe, expect, it } from 'vitest';
import { createBackend } from '../../../src/cli/backend.js';
import { handleServeCommand } from '../../../src/cli/commands/serve.js';
import { testLogger } from '../../logger.js';

describe('handleServeCommand', () => {
  it('should launch server and log formatted endpoints', async () => {
    const storage = createBackend('memory');
    const running = await handleServeCommand(
      storage,
      'memory',
      '.data',
      0,
      '127.0.0.1',
    );

    expect(running).toBeDefined();
    expect(
      testLogger.hasMessage('TetherDB server listening at: http://127.0.0.1:'),
    ).toBe(true);
    expect(testLogger.hasMessage('Sync endpoint: ws://127.0.0.1:')).toBe(true);
    expect(
      testLogger.hasMessage('Storage backend: in-memory (ephemeral)'),
    ).toBe(true);

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
    expect(
      testLogger.hasMessage('TetherDB server listening at: http://localhost:'),
    ).toBe(true);
    expect(
      testLogger.hasMessage('Storage backend: sqlite (/tmp/test-db)'),
    ).toBe(true);

    await running.close();
    await storage.close?.();
  });
});
