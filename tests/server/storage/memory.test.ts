import { describe, expect, it } from 'vitest';
import { MemoryStorageAdapter } from '../../../src/server/storage/memory.js';
import { type ChangeRecord, OperationType } from '../../../src/shared/types.js';

describe('src/server/storage/memory.ts (MemoryStorageAdapter)', () => {
  it('should store and retrieve records with Last-Write-Wins timestamps', async () => {
    const adapter = new MemoryStorageAdapter();

    const change1: ChangeRecord = {
      store: 'items',
      id: 'item-1',
      op: OperationType.Put,
      data: { name: 'Item Alpha' },
      timestamp: 100,
      clientId: 'client-A',
    };

    const res1 = await adapter.applyChanges('user-1', [change1]);
    expect(res1.applied).toHaveLength(1);
    expect(res1.newSeq).toBe(1);

    const rec = await adapter.getRecord('user-1', 'items', 'item-1');
    expect(rec).toBeDefined();
    expect(rec?.data).toEqual({ name: 'Item Alpha' });
    expect(rec?.version).toBe(1);

    // Newer change overwrites
    const change2: ChangeRecord = {
      store: 'items',
      id: 'item-1',
      op: OperationType.Put,
      data: { name: 'Item Alpha Updated' },
      timestamp: 200,
      clientId: 'client-B',
    };

    const res2 = await adapter.applyChanges('user-1', [change2]);
    expect(res2.applied).toHaveLength(1);
    expect(res2.newSeq).toBe(2);

    const rec2 = await adapter.getRecord('user-1', 'items', 'item-1');
    expect(rec2?.data).toEqual({ name: 'Item Alpha Updated' });
    expect(rec2?.version).toBe(2);

    // Stale change ignored
    const changeStale: ChangeRecord = {
      store: 'items',
      id: 'item-1',
      op: OperationType.Put,
      data: { name: 'Stale' },
      timestamp: 150,
      clientId: 'client-C',
    };

    const resStale = await adapter.applyChanges('user-1', [changeStale]);
    expect(resStale.applied).toHaveLength(0);
    expect(resStale.newSeq).toBe(2);
  });

  it('should isolate data across apps and users', async () => {
    const adapter = new MemoryStorageAdapter();

    await adapter.applyChanges(
      'u1',
      [
        {
          store: 'prefs',
          id: 'theme',
          op: OperationType.Put,
          data: 'dark',
          timestamp: 100,
          clientId: 'c1',
        },
      ],
      'appA',
    );

    await adapter.applyChanges(
      'u1',
      [
        {
          store: 'prefs',
          id: 'theme',
          op: OperationType.Put,
          data: 'light',
          timestamp: 100,
          clientId: 'c1',
        },
      ],
      'appB',
    );

    const rA = await adapter.getRecord('u1', 'prefs', 'theme', 'appA');
    const rB = await adapter.getRecord('u1', 'prefs', 'theme', 'appB');
    expect(rA?.data).toBe('dark');
    expect(rB?.data).toBe('light');

    expect(await adapter.listApps('u1')).toEqual(['appA', 'appB']);
    expect(await adapter.listStores('u1', 'appA')).toEqual(['prefs']);
  });

  it('should enforce limits on store count, record count, and record byte size', async () => {
    const adapter = new MemoryStorageAdapter({
      limits: {
        allowedStores: ['allowed'],
        maxRecordSizeBytes: 30,
        maxRecordsPerStore: 2,
        maxStoresPerUser: 1,
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
          clientId: 'c1',
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
          data: { large: 'a'.repeat(50) },
          timestamp: 100,
          clientId: 'c1',
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
        clientId: 'c1',
      },
      {
        store: 'allowed',
        id: '2',
        op: OperationType.Put,
        data: 'b',
        timestamp: 101,
        clientId: 'c1',
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
          clientId: 'c1',
        },
      ]),
    ).rejects.toThrow('reached the maximum capacity of 2');
  });

  it('should compact changelog and flag snapshot requirement', async () => {
    const adapter = new MemoryStorageAdapter({
      limits: { maxChangelogEntries: 3 },
    });

    for (let i = 1; i <= 5; i++) {
      await adapter.applyChanges('u1', [
        {
          store: 'items',
          id: `item-${i}`,
          op: OperationType.Put,
          data: `val-${i}`,
          timestamp: 100 + i,
          clientId: 'c1',
        },
      ]);
    }

    expect(await adapter.getCurrentSeq('u1')).toBe(5);

    // Old sequence (compacted away)
    const oldDiff = await adapter.getChangesSince('u1', 1);
    expect(oldDiff.requiresSnapshot).toBe(true);

    // Recent sequence
    const recentDiff = await adapter.getChangesSince('u1', 3);
    expect(recentDiff.requiresSnapshot).toBe(false);
    expect(recentDiff.changes).toHaveLength(2);
  });
});
