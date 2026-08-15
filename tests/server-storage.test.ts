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

    it('should write data in sharded per-user sub-directories on filesystem', async () => {
      const change: ChangeRecord = {
        store: 'settings',
        id: 'theme',
        op: OperationType.Put,
        data: { dark: true },
        timestamp: Date.now(),
        clientId: 'client-1',
      };

      await adapter.applyChanges('user-42', [change]);

      // Sharded layout: tmpDir / us / user-42 / ...
      const shard = 'user-42'.slice(0, 2).toLowerCase();
      const userDir = path.join(tmpDir, shard, 'user-42');
      const storeFile = path.join(userDir, 'stores', 'settings.json');
      const metaFile = path.join(userDir, 'meta.json');

      const fileContent = await fs.readFile(storeFile, 'utf-8');
      const storeObj = JSON.parse(fileContent);
      expect(storeObj.theme.data).toEqual({ dark: true });

      const metaContent = await fs.readFile(metaFile, 'utf-8');
      const metaObj = JSON.parse(metaContent);
      expect(metaObj.currentSeq).toBe(1);
    });

    it('should reject path traversal attempts in userId or store name', async () => {
      const evilChange: ChangeRecord = {
        store: '../../../etc',
        id: 'hack',
        op: OperationType.Put,
        data: 'pwned',
        timestamp: Date.now(),
      };

      await expect(
        adapter.applyChanges('user-1', [evilChange]),
      ).rejects.toThrow();
      await expect(
        adapter.applyChanges('../../evil-user', [
          {
            store: 'safe',
            id: '1',
            op: OperationType.Put,
            data: 'val',
            timestamp: 100,
          },
        ]),
      ).rejects.toThrow();
    });

    it('should compact changelog beyond maxChangelogEntries and flag requiresSnapshot', async () => {
      const compactingAdapter = new FileStorageAdapter({
        baseDir: tmpDir,
        limits: { maxChangelogEntries: 5 },
      });

      // Apply 10 changes sequentially
      for (let i = 1; i <= 10; i++) {
        await compactingAdapter.applyChanges('user-compaction', [
          {
            store: 'events',
            id: `e-${i}`,
            op: OperationType.Put,
            data: `event-${i}`,
            timestamp: 1000 + i,
          },
        ]);
      }

      // Asking for seq 1 (which was pruned) should return requiresSnapshot: true
      const oldDiff = await compactingAdapter.getChangesSince(
        'user-compaction',
        1,
      );
      expect(oldDiff.requiresSnapshot).toBe(true);

      // Asking for recent seq 7 (retained in window) should return delta diff
      const recentDiff = await compactingAdapter.getChangesSince(
        'user-compaction',
        7,
      );
      expect(recentDiff.requiresSnapshot).toBe(false);
      expect(recentDiff.changes).toHaveLength(3);
    });

    it('should enforce server limits on record size and allowed stores', async () => {
      const limitedAdapter = new FileStorageAdapter({
        baseDir: tmpDir,
        limits: {
          allowedStores: ['todos', 'notes'],
          maxRecordSizeBytes: 50,
        },
      });

      // Disallowed store
      await expect(
        limitedAdapter.applyChanges('user-limits', [
          {
            store: 'secrets',
            id: '1',
            op: OperationType.Put,
            data: 'hello',
            timestamp: 100,
          },
        ]),
      ).rejects.toThrow('not in the allowed stores list');

      // Oversized record
      await expect(
        limitedAdapter.applyChanges('user-limits', [
          {
            store: 'todos',
            id: '1',
            op: OperationType.Put,
            data: { text: 'A'.repeat(100) },
            timestamp: 100,
          },
        ]),
      ).rejects.toThrow('Record size');
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
