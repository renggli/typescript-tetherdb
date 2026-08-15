import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAuthAdapter } from '../../../src/server/auth/sqlite.js';
import { SqliteStorageAdapter } from '../../../src/server/storage/sqlite.js';
import { OperationType } from '../../../src/shared/types.js';

describe('src/server/storage/sqlite.ts (SqliteStorageAdapter)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-sqlite-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('should persist and reload records across database connection instances in per-app database files', async () => {
    const adapter1 = new SqliteStorageAdapter({ baseDir: tmpDir });

    await adapter1.applyChanges('u1', [
      {
        store: 'notes',
        id: 'n1',
        op: OperationType.Put,
        data: { text: 'Persistent SQLite note' },
        timestamp: 1000,
        clientId: 'c1',
      },
    ]);

    const r1 = await adapter1.getRecord('u1', 'notes', 'n1');
    expect(r1?.data).toEqual({ text: 'Persistent SQLite note' });
    expect(r1?.version).toBe(1);

    // Verify default.sqlite file exists in tmpDir
    const defaultDbExists = await fs
      .access(path.join(tmpDir, 'default.sqlite'))
      .then(() => true)
      .catch(() => false);
    expect(defaultDbExists).toBe(true);

    await adapter1.close();

    // Reopen with new adapter instance pointing to same baseDir
    const adapter2 = new SqliteStorageAdapter({ baseDir: tmpDir });

    const r2 = await adapter2.getRecord('u1', 'notes', 'n1');
    expect(r2?.data).toEqual({ text: 'Persistent SQLite note' });
    expect(r2?.version).toBe(1);

    const all = await adapter2.getAllRecords('u1');
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('n1');

    await adapter2.close();
  });

  it('should create separate SQLite database files per application in baseDir', async () => {
    const adapter = new SqliteStorageAdapter({ baseDir: tmpDir });

    // User A, App 1
    await adapter.applyChanges(
      'userA',
      [
        {
          store: 'todos',
          id: '1',
          op: OperationType.Put,
          data: { task: 'Task A1' },
          timestamp: 100,
          clientId: 'c1',
        },
      ],
      'app1',
    );

    // User A, App 2
    await adapter.applyChanges(
      'userA',
      [
        {
          store: 'todos',
          id: '1',
          op: OperationType.Put,
          data: { task: 'Task A2' },
          timestamp: 200,
          clientId: 'c1',
        },
      ],
      'app2',
    );

    // User B, App 1
    await adapter.applyChanges(
      'userB',
      [
        {
          store: 'todos',
          id: '1',
          op: OperationType.Put,
          data: { task: 'Task B1' },
          timestamp: 300,
          clientId: 'c1',
        },
      ],
      'app1',
    );

    const a1 = await adapter.getRecord('userA', 'todos', '1', 'app1');
    const a2 = await adapter.getRecord('userA', 'todos', '1', 'app2');
    const b1 = await adapter.getRecord('userB', 'todos', '1', 'app1');

    expect(a1?.data).toEqual({ task: 'Task A1' });
    expect(a2?.data).toEqual({ task: 'Task A2' });
    expect(b1?.data).toEqual({ task: 'Task B1' });

    // Verify separate sqlite files exist for each app
    const app1Exists = await fs
      .access(path.join(tmpDir, 'app1.sqlite'))
      .then(() => true)
      .catch(() => false);
    const app2Exists = await fs
      .access(path.join(tmpDir, 'app2.sqlite'))
      .then(() => true)
      .catch(() => false);
    expect(app1Exists).toBe(true);
    expect(app2Exists).toBe(true);

    const appsUserA = await adapter.listApps('userA');
    expect(appsUserA).toEqual(['app1', 'app2']);

    const allApps = await adapter.listApps();
    expect(allApps).toEqual(['app1', 'app2']);

    const stores = await adapter.listStores('userA', 'app1');
    expect(stores).toEqual(['todos']);

    await adapter.close();
  });

  it('should allow auth and storage to share the same baseDir cleanly', async () => {
    const auth = new SqliteAuthAdapter({ baseDir: tmpDir });
    const storage = new SqliteStorageAdapter({ baseDir: tmpDir });

    const reg = await auth.register('shared_user', 'password123');
    await storage.applyChanges(
      reg.userId,
      [
        {
          store: 'notes',
          id: 'note-1',
          op: OperationType.Put,
          data: { title: 'Shared dir test' },
          timestamp: 1000,
          clientId: 'client-1',
        },
      ],
      'shared_app',
    );

    // Verify auth.sqlite and shared_app.sqlite coexist in tmpDir
    const authFileExists = await fs
      .access(path.join(tmpDir, 'auth.sqlite'))
      .then(() => true)
      .catch(() => false);
    const appFileExists = await fs
      .access(path.join(tmpDir, 'shared_app.sqlite'))
      .then(() => true)
      .catch(() => false);

    expect(authFileExists).toBe(true);
    expect(appFileExists).toBe(true);

    // listApps excludes auth.sqlite
    const apps = await storage.listApps();
    expect(apps).toEqual(['shared_app']);

    await auth.close();
    await storage.close();
  });

  it('should compact changelog and return requiresSnapshot for pruned sequences', async () => {
    const adapter = new SqliteStorageAdapter({
      baseDir: tmpDir,
      limits: { maxChangelogEntries: 3 },
    });

    for (let i = 1; i <= 6; i++) {
      await adapter.applyChanges('u1', [
        {
          store: 'logs',
          id: `log-${i}`,
          op: OperationType.Put,
          data: `entry-${i}`,
          timestamp: 1000 + i,
        },
      ]);
    }

    expect(await adapter.getCurrentSeq('u1')).toBe(6);

    // Old sequence (pruned)
    const oldDiff = await adapter.getChangesSince('u1', 1);
    expect(oldDiff.requiresSnapshot).toBe(true);

    // Recent sequence (retained in window)
    const recentDiff = await adapter.getChangesSince('u1', 4);
    expect(recentDiff.requiresSnapshot).toBe(false);
    expect(recentDiff.changes).toHaveLength(2);
    expect(recentDiff.changes.map((c) => c.id)).toEqual(['log-5', 'log-6']);

    await adapter.close();
  });

  it('should enforce limits on allowed stores, record size, and store capacity', async () => {
    const adapter = new SqliteStorageAdapter({
      baseDir: tmpDir,
      limits: {
        allowedStores: ['allowed'],
        maxRecordSizeBytes: 50,
        maxRecordsPerStore: 2,
      },
    });

    // Disallowed store
    await expect(
      adapter.applyChanges('u1', [
        {
          store: 'forbidden',
          id: '1',
          op: OperationType.Put,
          data: 'val',
          timestamp: 100,
        },
      ]),
    ).rejects.toThrow('not in the allowed tables list');

    // Oversized record
    await expect(
      adapter.applyChanges('u1', [
        {
          store: 'allowed',
          id: '1',
          op: OperationType.Put,
          data: { big: 'x'.repeat(60) },
          timestamp: 100,
        },
      ]),
    ).rejects.toThrow('exceeds maximum allowed size');

    // Capacity limit
    await adapter.applyChanges('u1', [
      {
        store: 'allowed',
        id: '1',
        op: OperationType.Put,
        data: 'a',
        timestamp: 100,
      },
      {
        store: 'allowed',
        id: '2',
        op: OperationType.Put,
        data: 'b',
        timestamp: 101,
      },
    ]);

    await expect(
      adapter.applyChanges('u1', [
        {
          store: 'allowed',
          id: '3',
          op: OperationType.Put,
          data: 'c',
          timestamp: 102,
        },
      ]),
    ).rejects.toThrow('reached the maximum capacity of 2');

    await adapter.close();
  });

  it('should support inMemory mode for SqliteStorageAdapter', async () => {
    const adapter = new SqliteStorageAdapter({ inMemory: true });

    await adapter.applyChanges('u1', [
      {
        store: 'inmem_store',
        id: '1',
        op: OperationType.Put,
        data: { hello: 'world' },
        timestamp: 100,
      },
    ]);

    const rec = await adapter.getRecord('u1', 'inmem_store', '1');
    expect(rec?.data).toEqual({ hello: 'world' });

    await adapter.close();
  });
});
