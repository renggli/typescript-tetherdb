import type * as http from 'node:http';
import { describe, expect, it } from 'vitest';
import {
  handleHealth,
  handleMetrics,
  handleReady,
} from '../../../src/server/http/system.js';
import { MemoryStorage } from '../../../src/server/storage/memory/storage.js';
import type { Storage } from '../../../src/server/storage/storage.js';

describe('handleHealth', () => {
  it('should respond with status ok and uptime', () => {
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

    handleHealth(req, res, true);
    expect(statusCode).toBe(200);
    const parsed = JSON.parse(payload);
    expect(parsed.status).toBe('ok');
    expect(typeof parsed.uptime).toBe('number');
  });
});

describe('handleReady', () => {
  it('should return 200 ready when storage is accessible', async () => {
    const storage = new MemoryStorage();
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

    await handleReady(req, res, storage, true, null);
    expect(statusCode).toBe(200);
    const parsed = JSON.parse(payload);
    expect(parsed.status).toBe('ready');
  });

  it('should return 503 unready when storage throws an error', async () => {
    const brokenStorage = {
      getTables: async () => {
        throw new Error('Database disk full');
      },
    } as unknown as Storage;

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

    await handleReady(req, res, brokenStorage, true, null);
    expect(statusCode).toBe(503);
    const parsed = JSON.parse(payload);
    expect(parsed.status).toBe('unready');
    expect(parsed.error).toBe('Database disk full');
  });
});

describe('handleMetrics', () => {
  it('should return system metrics including tables and connected clients', async () => {
    const storage = new MemoryStorage();
    await storage.createTable('tasks');

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

    await handleMetrics(req, res, storage, 5, true);
    expect(statusCode).toBe(200);
    const parsed = JSON.parse(payload);
    expect(parsed.connectedClients).toBe(5);
    expect(parsed.tablesCount).toBe(1);
    expect(typeof parsed.uptime).toBe('number');
    expect(parsed.memoryUsage).toBeDefined();
  });
});
