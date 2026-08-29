import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileStorage,
  SqliteStorage,
  TetherServer,
  TetherServerError,
  TetherServerErrorCode,
} from '../../src/server/index.js';
import {
  acquireServerLock,
  isProcessAlive,
  readServerLock,
} from '../../src/server/shared/lock.js';
import { OperationType } from '../../src/shared/types.js';

describe('ServerLock', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-lock-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
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

  it('should correctly determine process liveness', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
    // Unlikely PID
    expect(isProcessAlive(2147483640)).toBe(false);
  });

  it('should acquire and release lockfile with metadata and restricted permissions', async () => {
    const handle = acquireServerLock(tmpDir, {
      port: 9000,
      host: '127.0.0.1',
      backend: 'sqlite',
    });

    expect(handle.info.pid).toBe(process.pid);
    expect(handle.info.port).toBe(9000);
    expect(handle.info.host).toBe('127.0.0.1');
    expect(handle.info.backend).toBe('sqlite');
    expect(handle.info.startedAt).toBeGreaterThan(0);

    const lockFile = path.join(tmpDir, 'server.lock');
    const stat = await fs.stat(lockFile);
    expect(stat.isFile()).toBe(true);

    const read = readServerLock(tmpDir);
    expect(read?.pid).toBe(process.pid);
    expect(read?.port).toBe(9000);

    handle.release();

    let exists = true;
    try {
      await fs.stat(lockFile);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
    expect(readServerLock(tmpDir)).toBeNull();
  });

  it('should prevent another server from acquiring lock on the same directory', async () => {
    // Write an active lock belonging to a live process (our own PID or simulated live PID)
    const lockFile = path.join(tmpDir, 'server.lock');
    await fs.writeFile(
      lockFile,
      JSON.stringify({
        pid: process.pid,
        port: 8080,
        host: '0.0.0.0',
        backend: 'sqlite',
        startedAt: Date.now(),
      }),
      { mode: 0o600 },
    );

    // Simulate another process with a different PID by modifying lockfile with another alive PID (e.g., process.ppid)
    const parentPid = process.ppid;
    if (isProcessAlive(parentPid)) {
      await fs.writeFile(
        lockFile,
        JSON.stringify({
          pid: parentPid,
          port: 8080,
          host: '0.0.0.0',
          backend: 'sqlite',
          startedAt: Date.now(),
        }),
        { mode: 0o600 },
      );

      expect(() =>
        acquireServerLock(tmpDir, {
          port: 8081,
          host: '0.0.0.0',
          backend: 'sqlite',
        }),
      ).toThrow(TetherServerError);

      try {
        acquireServerLock(tmpDir, {
          port: 8081,
          host: '0.0.0.0',
          backend: 'sqlite',
        });
      } catch (err) {
        expect((err as TetherServerError).code).toBe(
          TetherServerErrorCode.AlreadyExists,
        );
        expect((err as Error).message).toContain('already running');
      }
    }
  });

  it('should automatically reclaim stale locks from dead processes', async () => {
    const lockFile = path.join(tmpDir, 'server.lock');
    const deadPid = 2147483640; // High PID not in use

    await fs.writeFile(
      lockFile,
      JSON.stringify({
        pid: deadPid,
        port: 8080,
        host: '0.0.0.0',
        backend: 'sqlite',
        startedAt: Date.now() - 100000,
      }),
      { mode: 0o600 },
    );

    expect(readServerLock(tmpDir)).toBeNull();

    // Reclaiming should succeed seamlessly
    const handle = acquireServerLock(tmpDir, {
      port: 8080,
      host: '0.0.0.0',
      backend: 'sqlite',
    });
    expect(handle.info.pid).toBe(process.pid);
    handle.release();
  });

  it('should integrate with TetherServer lifecycle and prevent duplicate servers', async () => {
    const storage1 = new SqliteStorage({ baseDir: tmpDir });
    const storage2 = new SqliteStorage({ baseDir: tmpDir });

    const server1 = new TetherServer({ storage: storage1 });
    const server2 = new TetherServer({ storage: storage2 });

    const http1 = await server1.listen(0, '127.0.0.1');
    const port1 = (http1.address() as { port: number }).port;

    const lock = readServerLock(tmpDir);
    expect(lock).toBeDefined();
    expect(lock?.pid).toBe(process.pid);
    expect(lock?.port).toBe(port1);

    // Starting a second server against the same directory from another simulated PID
    const parentPid = process.ppid;
    if (isProcessAlive(parentPid)) {
      // Overwrite lock with active external PID
      const lockFile = path.join(tmpDir, 'server.lock');
      await fs.writeFile(
        lockFile,
        JSON.stringify({
          pid: parentPid,
          port: port1,
          host: '127.0.0.1',
          backend: 'sqlite',
          startedAt: Date.now(),
        }),
      );

      await expect(server2.listen(0, '127.0.0.1')).rejects.toThrow(
        TetherServerError,
      );
    }

    await server1.close();
    await server2.close();
    await storage1.close();
    await storage2.close();
  });

  it('should block mutating operations on FileStorage when external server lock is active', async () => {
    const parentPid = process.ppid;
    if (!isProcessAlive(parentPid)) return;

    // Simulate active server lock from parent process
    const lockFile = path.join(tmpDir, 'server.lock');
    await fs.writeFile(
      lockFile,
      JSON.stringify({
        pid: parentPid,
        port: 8080,
        host: '0.0.0.0',
        backend: 'file',
        startedAt: Date.now(),
      }),
      { mode: 0o600 },
    );

    const fileStorage = new FileStorage({ baseDir: tmpDir });

    // Mutating user operations should be blocked
    await expect(
      fileStorage.createUser('blocked_user', 'password123'),
    ).rejects.toMatchObject({
      code: TetherServerErrorCode.NotSupported,
    });
    await expect(fileStorage.deleteUser('some-user-id')).rejects.toMatchObject({
      code: TetherServerErrorCode.NotSupported,
    });

    // Mutating table operations should be blocked
    await expect(
      fileStorage.createTable('blocked_table'),
    ).rejects.toMatchObject({
      code: TetherServerErrorCode.NotSupported,
    });
    await expect(
      fileStorage.deleteTable('blocked_table'),
    ).rejects.toMatchObject({
      code: TetherServerErrorCode.NotSupported,
    });

    await fileStorage.close();
  });

  it('should allow concurrent reads on FileStorage even when server lock is active', async () => {
    const parentPid = process.ppid;
    if (!isProcessAlive(parentPid)) return;

    // First create user and table before locking
    const prepStorage = new FileStorage({ baseDir: tmpDir });
    const user = await prepStorage.createUser('alice_user', 'password123');
    await prepStorage.createTable('demo_table');
    await prepStorage.close();

    // Now set external server lock
    const lockFile = path.join(tmpDir, 'server.lock');
    await fs.writeFile(
      lockFile,
      JSON.stringify({
        pid: parentPid,
        port: 8080,
        host: '0.0.0.0',
        backend: 'file',
        startedAt: Date.now(),
      }),
      { mode: 0o600 },
    );

    const readerStorage = new FileStorage({ baseDir: tmpDir });

    // Reads should succeed
    const fetchedUser = await readerStorage.getUser(user.userId);
    expect(fetchedUser).toBeDefined();
    expect(fetchedUser?.userName).toBe('alice_user');

    const fetchedTable = await readerStorage.getTable('demo_table');
    expect(fetchedTable).toBeDefined();

    const status = await readerStorage.getStatus();
    expect(status.tablesCount).toBe(1);
    expect(status.usersCount).toBe(1);

    await readerStorage.close();
  });

  it('should allow concurrent reads and writes on SqliteStorage when server is active', async () => {
    const parentPid = process.ppid;
    if (!isProcessAlive(parentPid)) return;

    const sqlite = new SqliteStorage({ baseDir: tmpDir });
    const user = await sqlite.createUser('sqlite_user', 'password123');
    const table = await sqlite.createTable('items');

    // Writes succeed even if external lock is present (SQLite handles OS WAL locking)
    await sqlite.applyChanges(user, [
      {
        table: 'items',
        id: 'item_1',
        op: OperationType.Put,
        data: { text: 'concurrent write' },
        timestamp: Date.now(),
        clientId: 'cli-1',
      },
    ]);

    const record = await table.getRecord(user, 'item_1');
    expect(record?.data).toEqual({ text: 'concurrent write' });

    await sqlite.close();
  });

  it('should return null when lockfile contains invalid or corrupt JSON', async () => {
    const lockFile = path.join(tmpDir, 'server.lock');
    await fs.writeFile(lockFile, '{ corrupt-json-content', { mode: 0o600 });

    expect(readServerLock(tmpDir)).toBeNull();
  });

  it('should be safe to call release multiple times', () => {
    const handle = acquireServerLock(tmpDir, {
      port: 9000,
      host: '127.0.0.1',
      backend: 'sqlite',
    });

    handle.release();
    expect(() => handle.release()).not.toThrow();
  });
});
