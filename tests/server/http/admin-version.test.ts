import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from '../../../src/server/server.js';
import { MemoryStorage } from '../../../src/server/storage/memory.js';
import { TETHER_VERSION } from '../../../src/shared/version.js';

describe('GET /admin/version', () => {
  let server: RunningServer;
  let baseUrl: string;
  let adminSecret: string;

  beforeEach(async () => {
    const storage = new MemoryStorage();
    server = await startServer({
      port: 0,
      host: '127.0.0.1',
      storage,
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
    adminSecret = server.server.adminSecret;
  });

  afterEach(async () => {
    await server.close();
  });

  it('should return 401 Unauthorized without admin secret', async () => {
    const res = await fetch(`${baseUrl}/admin/version`);
    expect(res.status).toBe(401);
  });

  it('should return 401 Unauthorized with invalid admin secret', async () => {
    const res = await fetch(`${baseUrl}/admin/version`, {
      headers: { Authorization: 'Bearer invalid-token' },
    });
    expect(res.status).toBe(401);
  });

  it('should return version information with valid admin secret', async () => {
    const res = await fetch(`${baseUrl}/admin/version`, {
      headers: { Authorization: `Bearer ${adminSecret}` },
    });
    expect(res.status).toBe(200);

    const data = (await res.json()) as { version: string; hash?: string };
    expect(data.version).toBe(TETHER_VERSION);
    if (data.hash) {
      expect(typeof data.hash).toBe('string');
      expect(data.hash.length).toBeGreaterThan(0);
    }
  });

  it('should accept x-admin-secret header', async () => {
    const res = await fetch(`${baseUrl}/admin/version`, {
      headers: { 'x-admin-secret': adminSecret },
    });
    expect(res.status).toBe(200);

    const data = (await res.json()) as { version: string; hash?: string };
    expect(data.version).toBe(TETHER_VERSION);
  });
});
