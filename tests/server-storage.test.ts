import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StorageAdapter } from '../src/server/storage/adapter.js';
import { FileStorageAdapter } from '../src/server/storage/file.js';
import { MemoryStorageAdapter } from '../src/server/storage/memory.js';
import { type ChangeRecord, OperationType } from '../src/shared/types.js';

describe('Storage Adapters', () => {
  describe('MemoryStorageAdapter', () => {
    runStorageTestSuite(() => new MemoryStorageAdapter());
  });

  describe('FileStorageAdapter', () => {
    let tmpDir: string;
    let adapter: FileStorageAdapter;

    beforeEach(async () => {
      tmpDir = path.join(
        os.tmpdir(),
        `beameddb-test-${Math.random().toString(36).substring(2, 10)}`,
      );
      await fs.mkdir(tmpDir, { recursive: true });
      adapter = new FileStorageAdapter({ baseDir: tmpDir });
    });

    afterEach(async () => {
      await adapter.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    runStorageTestSuite(() => adapter);

    it('should write data in per-user sub-directories on filesystem', async () => {
      const change: ChangeRecord = {
        store: 'settings',
        id: 'theme',
        op: OperationType.Put,
        data: { dark: true },
        timestamp: Date.now(),
        clientId: 'client-1',
      };

      await adapter.applyChanges('user-42', [change]);

      const userDir = path.join(tmpDir, 'user-42');
      const storeFile = path.join(userDir, 'stores', 'settings.json');
      const metaFile = path.join(userDir, 'meta.json');

      const fileContent = await fs.readFile(storeFile, 'utf-8');
      const storeObj = JSON.parse(fileContent);
      expect(storeObj.theme.data).toEqual({ dark: true });

      const metaContent = await fs.readFile(metaFile, 'utf-8');
      const metaObj = JSON.parse(metaContent);
      expect(metaObj.currentSeq).toBe(1);
    });
  });
});

function runStorageTestSuite(createAdapter: () => StorageAdapter) {
  let adapter: StorageAdapter;

  beforeEach(() => {
    adapter = createAdapter();
  });

  it('should apply changes and assign sequential numbers', async () => {
    const changes: ChangeRecord[] = [
      {
        store: 'todos',
        id: 't1',
        op: OperationType.Put,
        data: { title: 'Item 1' },
        timestamp: 1000,
        clientId: 'c1',
      },
      {
        store: 'todos',
        id: 't2',
        op: OperationType.Put,
        data: { title: 'Item 2' },
        timestamp: 1001,
        clientId: 'c1',
      },
    ];

    const res = await adapter.applyChanges('user-1', changes);
    expect(res.applied).toHaveLength(2);
    expect(res.newSeq).toBe(2);

    const record = await adapter.getRecord('user-1', 'todos', 't1');
    expect(record?.data).toEqual({ title: 'Item 1' });

    const all = await adapter.getAllRecords('user-1');
    expect(all).toHaveLength(2);
  });

  it('should isolate data between different users', async () => {
    await adapter.applyChanges('user-A', [
      {
        store: 'notes',
        id: 'secret',
        op: OperationType.Put,
        data: { secret: 'User A secret' },
        timestamp: 1000,
        clientId: 'c1',
      },
    ]);

    const userARecord = await adapter.getRecord('user-A', 'notes', 'secret');
    expect(userARecord?.data).toEqual({ secret: 'User A secret' });

    const userBRecord = await adapter.getRecord('user-B', 'notes', 'secret');
    expect(userBRecord).toBeUndefined();

    const userBAll = await adapter.getAllRecords('user-B');
    expect(userBAll).toHaveLength(0);
  });

  it('should handle diffs since sequence', async () => {
    await adapter.applyChanges('user-1', [
      {
        store: 'items',
        id: '1',
        op: OperationType.Put,
        data: 'v1',
        timestamp: 10,
        clientId: 'c',
      },
      {
        store: 'items',
        id: '2',
        op: OperationType.Put,
        data: 'v2',
        timestamp: 20,
        clientId: 'c',
      },
      {
        store: 'items',
        id: '3',
        op: OperationType.Put,
        data: 'v3',
        timestamp: 30,
        clientId: 'c',
      },
    ]);

    const diff = await adapter.getChangesSince('user-1', 1);
    expect(diff.changes).toHaveLength(2);
    expect(diff.changes.map((c) => c.id)).toEqual(['2', '3']);
    expect(diff.currentSeq).toBe(3);
  });
}
