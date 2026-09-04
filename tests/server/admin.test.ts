import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AdminClient,
  decodeAdminToken,
  encodeAdminToken,
  LocalAdminTarget,
} from '../../src/server/admin.js';
import { SqliteStorage, TetherServer } from '../../src/server/index.js';

describe('AdminTarget (LocalAdminTarget & AdminClient)', () => {
  let tmpDir: string;
  let storage: SqliteStorage;
  let server: TetherServer | null = null;
  let localTarget: LocalAdminTarget;
  let remoteTarget: AdminClient | null = null;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-admin-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    storage = new SqliteStorage({ baseDir: tmpDir });
    localTarget = new LocalAdminTarget(storage);
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    await storage.close();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should perform full administrative CRUD and maintenance via LocalAdminTarget', async () => {
    // 1. Table CRUD
    await localTarget.createTable('tasks', { maxRecords: 100 });
    const tables = await localTarget.getTables();
    expect(tables.map((t) => t.name)).toContain('tasks');

    const table = await localTarget.getTable('tasks');
    expect(table?.settings?.maxRecords).toBe(100);

    const updated = await localTarget.updateTable('tasks', { maxRecords: 200 });
    expect(updated.settings?.maxRecords).toBe(200);

    // 2. User CRUD
    const user = await localTarget.createUser('alice', 'password123');
    expect(user.userName).toBe('alice');
    const users = await localTarget.getUsers();
    expect(users.map((u) => u.userName)).toContain('alice');

    const renamed = await localTarget.renameUser(user.userId, 'alicia');
    expect(renamed.userId).toBe(user.userId);
    expect(renamed.userName).toBe('alicia');

    // 3. Record CRUD
    await localTarget.putRecord(
      'tasks',
      'rec-1',
      { title: 'First Task' },
      user.userId,
    );
    const records = await localTarget.getRecords('tasks', user.userId);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('rec-1');
    expect(records[0].data).toEqual({ title: 'First Task' });

    await localTarget.deleteRecord('tasks', 'rec-1', user.userId);
    const recordsAfterDelete = await localTarget.getRecords(
      'tasks',
      user.userId,
    );
    expect(recordsAfterDelete).toHaveLength(0);

    // 4. Maintenance & Status & Version
    const version = await localTarget.getVersion();
    expect(version.version).toBeDefined();

    const status = await localTarget.getStatus();
    expect(status.tablesCount).toBe(1);
    expect(status.usersCount).toBe(1);

    const checkpointRes = await localTarget.checkpoint();
    expect(checkpointRes.action).toBe('checkpoint');

    const vacuumRes = await localTarget.vacuum();
    expect(vacuumRes.action).toBe('vacuum');

    const pruneRes = await localTarget.prune(10);
    expect(pruneRes.action).toBe('prune');

    // Cleanup
    await localTarget.deleteUser(user.userId);
    await localTarget.deleteTable('tasks');
    expect(await localTarget.getTable('tasks')).toBeUndefined();
  });

  it('should perform full administrative CRUD and maintenance via AdminClient against a running server', async () => {
    server = new TetherServer({ storage });
    const httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 8080;

    remoteTarget = new AdminClient(port, '127.0.0.1', server.adminSecret);

    // 1. Table CRUD
    await remoteTarget.createTable('remotetasks', { maxRecords: 50 });
    const tables = await remoteTarget.getTables();
    expect(tables.map((t) => t.name)).toContain('remotetasks');

    const table = await remoteTarget.getTable('remotetasks');
    expect(table?.settings?.maxRecords).toBe(50);

    const updated = await remoteTarget.updateTable('remotetasks', {
      maxRecords: 150,
    });
    expect(updated.settings?.maxRecords).toBe(150);

    // 2. User CRUD
    const user = await remoteTarget.createUser('bobby', 'secretpass');
    expect(user.userName).toBe('bobby');
    const users = await remoteTarget.getUsers();
    expect(users.map((u) => u.userName)).toContain('bobby');

    const renamedUser = await remoteTarget.renameUser(user.userId, 'roberto');
    expect(renamedUser.userId).toBe(user.userId);
    expect(renamedUser.userName).toBe('roberto');

    // 3. Record CRUD
    await remoteTarget.putRecord(
      'remotetasks',
      'rec-remote',
      { title: 'Remote Task' },
      user.userId,
    );
    const records = await remoteTarget.getRecords('remotetasks', user.userId);
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('rec-remote');
    expect(records[0].data).toEqual({ title: 'Remote Task' });

    await remoteTarget.deleteRecord('remotetasks', 'rec-remote', user.userId);
    const recordsAfterDelete = await remoteTarget.getRecords(
      'remotetasks',
      user.userId,
    );
    expect(recordsAfterDelete).toHaveLength(0);

    // 4. Maintenance & Status & Version
    const version = await remoteTarget.getVersion();
    expect(version.version).toBeDefined();

    const status = await remoteTarget.getStatus();
    expect(status.tablesCount).toBe(1);
    expect(status.usersCount).toBe(1);

    const checkpointRes = await remoteTarget.checkpoint();
    expect(checkpointRes.action).toBe('checkpoint');

    const vacuumRes = await remoteTarget.vacuum();
    expect(vacuumRes.action).toBe('vacuum');

    const pruneRes = await remoteTarget.prune(10);
    expect(pruneRes.action).toBe('prune');

    await expect(remoteTarget.prune(-10)).rejects.toThrow();

    // Table settings limits validation
    await expect(
      remoteTarget.updateTable('remotetasks', { maxRecords: -1 }),
    ).rejects.toThrow();
    await expect(
      remoteTarget.createTable('badtable', { maxRecordSizeBytes: -100 }),
    ).rejects.toThrow();
    await expect(
      remoteTarget.updateTable('remotetasks', { maxHistoryEntries: -5 }),
    ).rejects.toThrow();

    // Cleanup
    await remoteTarget.deleteUser(user.userId);
    await remoteTarget.deleteTable('remotetasks');
    expect(await remoteTarget.getTable('remotetasks')).toBeUndefined();
  });

  it('should encode and decode admin tokens correctly', () => {
    const payload = {
      host: '127.0.0.1',
      port: 8080,
      secret: 'super-secret-key-123',
    };
    const token = encodeAdminToken(payload);
    expect(typeof token).toBe('string');

    const decoded = decodeAdminToken(token);
    expect(decoded).toEqual(payload);
  });

  it('should throw on invalid admin token', () => {
    expect(() => decodeAdminToken('invalid-token')).toThrow();
    expect(() => decodeAdminToken('')).toThrow();
  });

  it('should throw NotFound on non-existent resources in LocalAdminTarget and support close', async () => {
    await expect(
      localTarget.updateTable('non_existent', { maxRecords: 10 }),
    ).rejects.toThrow(/Table "non_existent" not found/);
    await expect(localTarget.deleteTable('non_existent')).rejects.toThrow(
      /Table "non_existent" not found/,
    );
    await expect(localTarget.deleteUser('non_existent_id')).rejects.toThrow(
      /User "non_existent_id" not found/,
    );
    await expect(localTarget.getRecords('non_existent')).rejects.toThrow(
      /Table "non_existent" not found/,
    );
    await localTarget.close();
  });
});
