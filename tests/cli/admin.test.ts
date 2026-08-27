import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAdminTarget } from '../../src/cli/admin.js';
import {
  BackendType,
  SqliteStorage,
  TetherServer,
} from '../../src/server/index.js';

describe('resolveAdminTarget', () => {
  let tmpDir: string;
  let server: TetherServer | null = null;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-resolve-admin-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should resolve LocalAdminTarget when no server is running', async () => {
    const context = await resolveAdminTarget(tmpDir, BackendType.Sqlite);
    expect(context.isRemote).toBe(false);
    expect(context.lock).toBeNull();
    expect(context.target).toBeDefined();

    const status = await context.target.getStatus();
    expect(status.backend).toBe('sqlite');

    await context.close();
  });

  it('should resolve AdminClient when server is running with server.lock', async () => {
    const storage = new SqliteStorage({ baseDir: tmpDir });
    server = new TetherServer({ storage });
    await server.listen(0, '127.0.0.1');

    const context = await resolveAdminTarget(tmpDir, BackendType.Sqlite);
    expect(context.isRemote).toBe(true);
    expect(context.lock).not.toBeNull();
    expect(context.lock?.pid).toBe(process.pid);

    const status = await context.target.getStatus();
    expect(status.backend).toBe('sqlite');

    await context.close();
  });
});
