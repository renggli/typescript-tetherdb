import type * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  handleHealth,
  handleMetrics,
  handleReady,
} from '../../../src/server/http/system.js';
import { MemoryStorage } from '../../../src/server/storage/memory.js';
import type { Storage } from '../../../src/server/storage/storage.js';

function createMockHttp() {
  let statusCode = 0;
  let payload = '';

  const res = {
    writeHead: (code: number) => {
      statusCode = code;
    },
    end: (data: string) => {
      payload = data;
    },
  } as unknown as http.ServerResponse;

  const req = { headers: {} } as unknown as http.IncomingMessage;

  return {
    req,
    res,
    getStatusCode: () => statusCode,
    getParsedPayload: <T = unknown>(): T => JSON.parse(payload) as T,
  };
}

describe('handleHealth', () => {
  it('should respond with status ok and uptime', () => {
    const { req, res, getStatusCode, getParsedPayload } = createMockHttp();

    handleHealth(req, res, true);
    expect(getStatusCode()).toBe(200);
    const parsed = getParsedPayload<{ status: string; uptime: number }>();
    expect(parsed.status).toBe('ok');
    expect(typeof parsed.uptime).toBe('number');
  });
});

describe('handleReady', () => {
  it('should return 200 ready when storage is accessible', async () => {
    const storage = new MemoryStorage();
    const { req, res, getStatusCode, getParsedPayload } = createMockHttp();

    await handleReady(req, res, storage, true, null);
    expect(getStatusCode()).toBe(200);
    const parsed = getParsedPayload<{ status: string }>();
    expect(parsed.status).toBe('ready');
  });

  it('should return 503 unready when storage throws an error', async () => {
    const brokenStorage = {
      getTables: async () => {
        throw new Error('Database disk full');
      },
    } as unknown as Storage;

    const { req, res, getStatusCode, getParsedPayload } = createMockHttp();
    await handleReady(req, res, brokenStorage, true, null);
    expect(getStatusCode()).toBe(503);
    const parsed = getParsedPayload<{ status: string; error: string }>();
    expect(parsed.status).toBe('unready');
    expect(parsed.error).toBe('Database disk full');
  });

  it('should handle non-Error exceptions gracefully in handleReady', async () => {
    const nonErrorStorage = {
      getTables: async () => {
        throw 'Non-error string rejection';
      },
    } as unknown as Storage;
    const { req, res, getStatusCode, getParsedPayload } = createMockHttp();
    await handleReady(req, res, nonErrorStorage, true, null);
    expect(getStatusCode()).toBe(503);
    const parsed = getParsedPayload<{ status: string; error: string }>();
    expect(parsed.status).toBe('unready');
    expect(parsed.error).toBe('Storage unavailable');
  });
});

describe('handleMetrics', () => {
  it('should return system metrics including tables and connected clients', async () => {
    const storage = new MemoryStorage();
    await storage.createTable('tasks');

    const { req, res, getStatusCode, getParsedPayload } = createMockHttp();

    await handleMetrics(req, res, storage, 5, true);
    expect(getStatusCode()).toBe(200);
    const parsed = getParsedPayload<{
      connectedClients: number;
      tablesCount: number;
      uptime: number;
      memoryUsage: unknown;
    }>();
    expect(parsed.connectedClients).toBe(5);
    expect(parsed.tablesCount).toBe(1);
    expect(typeof parsed.uptime).toBe('number');
    expect(parsed.memoryUsage).toBeDefined();
  });
});
