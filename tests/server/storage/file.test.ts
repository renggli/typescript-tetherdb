import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStorageAdapter } from '../../../src/server/storage/file.js';
import { type ChangeRecord, OperationType } from '../../../src/shared/types.js';

describe('src/server/storage/file.ts (FileStorageAdapter)', () => {
  let tmpDir: string;
  let adapter: FileStorageAdapter;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-file-storage-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    adapter = new FileStorageAdapter({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await adapter.close();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('should persist and retrieve records in directory structure', async () => {
    const change: ChangeRecord = {
      store: 'profiles',
      id: 'usr_1',
      op: OperationType.Put,
      data: { name: 'Alice', role: 'admin' },
      timestamp: 1000,
      clientId: 'client-1',
    };

    const res = await adapter.applyChanges('user_123', [change]);
    expect(res.applied).toHaveLength(1);
    expect(res.newSeq).toBe(1);

    const record = await adapter.getRecord('user_123', 'profiles', 'usr_1');
    expect(record).toBeDefined();
    expect(record?.data).toEqual({ name: 'Alice', role: 'admin' });
    expect(record?.version).toBe(1);

    // Verify filesystem state file existence
    const userDir = path.join(tmpDir, 'default', 'us', 'user_123');
    const storeFile = path.join(userDir, 'stores', 'profiles.json');
    const exists = await fs
      .access(storeFile)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);
  });

  it('should reload state cleanly across new adapter instances on same directory', async () => {
    await adapter.applyChanges('user_persist', [
      {
        store: 'docs',
        id: 'doc_1',
        op: OperationType.Put,
        data: { title: 'First document' },
        timestamp: 500,
        clientId: 'c1',
      },
    ]);

    await adapter.close();

    // Reopen with new adapter instance
    const adapter2 = new FileStorageAdapter({ baseDir: tmpDir });
    const rec = await adapter2.getRecord('user_persist', 'docs', 'doc_1');
    expect(rec?.data).toEqual({ title: 'First document' });
    expect(rec?.version).toBe(1);

    const apps = await adapter2.listApps('user_persist');
    expect(apps).toContain('default');

    await adapter2.close();
  });

  it('should support deletions and list active stores only', async () => {
    await adapter.applyChanges('user_del', [
      {
        store: 'temp',
        id: 'tmp_1',
        op: OperationType.Put,
        data: 'temporary',
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    expect(await adapter.listStores('user_del')).toEqual(['temp']);

    await adapter.applyChanges('user_del', [
      {
        store: 'temp',
        id: 'tmp_1',
        op: OperationType.Delete,
        timestamp: 200,
        clientId: 'c1',
      },
    ]);

    const rec = await adapter.getRecord('user_del', 'temp', 'tmp_1');
    expect(rec?.deleted).toBe(true);

    const all = await adapter.getAllRecords('user_del');
    expect(all).toHaveLength(0);
  });
});
