import { describe, expect, it } from 'vitest';
import { TetherServer } from '../src/server/server.js';
import { MemoryStorage } from '../src/server/storage/memory.js';
import { TestLogger, testLogger } from './logger.js';

describe('TestLogger', () => {
  it('should capture log messages at different levels', () => {
    const logger = new TestLogger();
    logger.log('log message', 1, { a: 2 });
    logger.debug('debug message', 'extra');
    logger.info('info message');
    logger.warn('warn message');
    logger.error('error message', new Error('test error'));

    expect(logger.entries).toHaveLength(5);
    expect(logger.messages).toEqual([
      'log message',
      'debug message',
      'info message',
      'warn message',
      'error message',
    ]);
  });

  it('should filter entries by level using getByLevel', () => {
    const logger = new TestLogger();
    logger.info('info 1');
    logger.info('info 2');
    logger.error('error 1');

    expect(logger.getByLevel('info')).toHaveLength(2);
    expect(logger.getByLevel('error')).toHaveLength(1);
    expect(logger.getByLevel('warn')).toHaveLength(0);
  });

  it('should check messages with hasMessage using string and regex patterns', () => {
    const logger = new TestLogger();
    logger.info('User alice logged in', { userId: 'u-123' });
    logger.error('Failed to connect to database', { code: 'ERR_CONN' });

    expect(logger.hasMessage('alice')).toBe(true);
    expect(logger.hasMessage(/alice/)).toBe(true);
    expect(logger.hasMessage('u-123')).toBe(true);
    expect(logger.hasMessage('ERR_CONN', 'error')).toBe(true);
    expect(logger.hasMessage('ERR_CONN', 'info')).toBe(false);
    expect(logger.hasMessage('nonexistent')).toBe(false);
  });

  it('should clear recorded entries with clear()', () => {
    const logger = new TestLogger();
    logger.info('hello');
    expect(logger.entries).toHaveLength(1);

    logger.clear();
    expect(logger.entries).toHaveLength(0);
    expect(logger.messages).toHaveLength(0);
  });

  it('should capture console calls through global testLogger interceptor', () => {
    console.log('global console test message');
    console.warn('global warning test message');

    expect(testLogger.hasMessage('global console test message', 'log')).toBe(
      true,
    );
    expect(testLogger.hasMessage('global warning test message', 'warn')).toBe(
      true,
    );
  });

  it('should work seamlessly as custom logger in TetherServer', async () => {
    const customLogger = new TestLogger();
    const server = new TetherServer({
      storage: new MemoryStorage(),
      logger: customLogger,
      adminSecret: 'secret-key',
    });
    const running = await server.listen(0, '127.0.0.1');
    const port = (running.address() as { port: number }).port;

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);

      // Trigger 400 debug log with malformed json body
      await fetch(`http://127.0.0.1:${port}/admin/tables`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-key',
        },
        body: 'invalid-json',
      });

      expect(
        customLogger.hasMessage(/Client error handling HTTP request/, 'debug'),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });
});
