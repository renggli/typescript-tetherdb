import 'fake-indexeddb/auto';
import { beforeEach } from 'vitest';
import { testLogger } from './logger.js';

const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
for (const method of methods) {
  console[method] = (message?: unknown, ...args: unknown[]) => {
    testLogger[method](message, ...args);
  };
}

beforeEach(() => {
  testLogger.clear();
});
