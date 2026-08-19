import { describe, expect, it, vi } from 'vitest';
import { createBackend } from '../../../src/cli/backend.js';
import { handleServeCommand } from '../../../src/cli/commands/serve.js';

describe('handleServeCommand', () => {
  it('should launch server and log formatted endpoints', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const storage = createBackend('memory');
    const running = await handleServeCommand(
      storage,
      'memory',
      '.data',
      0,
      '127.0.0.1',
    );

    expect(running).toBeDefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'TetherDB server listening at: http://127.0.0.1:',
      ),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('WebSocket sync endpoint: ws://127.0.0.1:'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      'Storage backend: in-memory (ephemeral)',
    );

    await running.close();
    await storage.close?.();
    logSpy.mockRestore();
  });

  it('should format storage backend path for file/sqlite backends', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const storage = createBackend('memory');
    const running = await handleServeCommand(
      storage,
      'sqlite',
      '/tmp/test-db',
      0,
      '0.0.0.0',
    );

    expect(running).toBeDefined();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'TetherDB server listening at: http://localhost:',
      ),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Storage backend: sqlite (/tmp/test-db)'),
    );

    await running.close();
    await storage.close?.();
    logSpy.mockRestore();
  });
});
