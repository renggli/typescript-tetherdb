import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TetherClient } from '../../src/client/client.js';
import { OperationType } from '../../src/shared/types.js';

describe('TetherClient local operations (src/client/)', () => {
  let db: TetherClient;

  beforeEach(() => {
    db = new TetherClient({
      name: `test-db-${Math.random().toString(36).substring(2, 8)}`,
      appId: 'test-app',
    });
  });

  afterEach(async () => {
    await db.close();
  });

  it('should insert, retrieve, update and delete items locally', async () => {
    const todos = db.table<{ title: string; completed: boolean }>('todos');

    // Put item
    const item1 = await todos.put('1', {
      title: 'Buy groceries',
      completed: false,
    });
    expect(item1.title).toBe('Buy groceries');

    // Get item
    const retrieved = await todos.get('1');
    expect(retrieved).toEqual({ title: 'Buy groceries', completed: false });

    // Update item
    await todos.put('1', { title: 'Buy groceries', completed: true });
    const updated = await todos.get('1');
    expect(updated?.completed).toBe(true);

    // Get all
    await todos.put('2', { title: 'Read paper', completed: false });
    const all = await todos.getAll();
    expect(all).toHaveLength(2);

    // Delete item
    const deleted = await todos.delete('1');
    expect(deleted).toBe(true);

    const afterDelete = await todos.get('1');
    expect(afterDelete).toBeNull();

    const remaining = await todos.getAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('Read paper');
  });

  it('should perform atomic bulk operations (putAll, deleteAll, getAll with ids)', async () => {
    const todos = db.table<{ title: string }>('todos');

    // Empty operations handle gracefully
    expect(await todos.putAll([])).toEqual([]);
    expect(await todos.deleteAll([])).toBe(0);
    expect(await todos.getAll([])).toEqual([]);

    // Bulk put
    const items = [
      { id: 'b1', data: { title: 'Bulk 1' } },
      { id: 'b2', data: { title: 'Bulk 2' } },
      { id: 'b3', data: { title: 'Bulk 3' } },
    ];
    const saved = await todos.putAll(items);
    expect(saved).toHaveLength(3);

    // Filtered getAll
    const subset = await todos.getAll(['b1', 'b3', 'nonexistent']);
    expect(subset).toHaveLength(2);
    expect(subset).toEqual([{ title: 'Bulk 1' }, { title: 'Bulk 3' }]);

    // Bulk delete
    const deletedCount = await todos.deleteAll(['b1', 'b2']);
    expect(deletedCount).toBe(2);

    const remaining = await todos.getAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].title).toBe('Bulk 3');
  });

  it('should retrieve active records with metadata and remove them upon delete', async () => {
    const todos = db.table<{ title: string }>('todos');
    await todos.put('m1', { title: 'Meta 1' });
    await todos.put('m1', { title: 'Meta 1 v2' });

    const rec = await todos.getWithMetadata('m1');
    expect(rec).toBeDefined();
    expect(rec?.version).toBe(2);
    expect(rec?.data.title).toBe('Meta 1 v2');

    expect(await todos.getAllWithMetadata()).toHaveLength(1);

    await todos.delete('m1');
    expect(await todos.getWithMetadata('m1')).toBeUndefined();
    expect(await todos.getAllWithMetadata()).toHaveLength(0);
  });

  it('should support reactive subscription callbacks for local modifications', async () => {
    const todos = db.table<{ title: string }>('todos');
    const receivedEvents: Array<{
      op: OperationType;
      id: string;
      title?: string;
    }> = [];

    const unsubscribe = todos.subscribe((events) => {
      for (const e of events) {
        receivedEvents.push({
          op: e.op,
          id: e.id,
          title: e.data?.title,
        });
      }
    });

    await todos.put('sub1', { title: 'Reactive Item 1' });
    await todos.putAll([
      { id: 'sub2', data: { title: 'Reactive Item 2' } },
      { id: 'sub3', data: { title: 'Reactive Item 3' } },
    ]);
    await todos.delete('sub1');
    await todos.deleteAll(['sub2', 'sub3']);

    expect(receivedEvents).toHaveLength(6);
    expect(receivedEvents[0]).toEqual({
      op: OperationType.Put,
      id: 'sub1',
      title: 'Reactive Item 1',
    });
    expect(receivedEvents[3]).toEqual({
      op: OperationType.Delete,
      id: 'sub1',
      title: undefined,
    });

    unsubscribe();
    await todos.put('sub4', { title: 'After unsubscribe' });
    expect(receivedEvents).toHaveLength(6);
  });

  it('should record local mutations into outbox', async () => {
    const todos = db.table<{ title: string }>('todos');
    await todos.put('out1', { title: 'Outbox Test' });

    const outbox = await db.idb.getPendingOutbox();
    expect(outbox).toHaveLength(1);
    expect(outbox[0].change.table).toBe('todos');
    expect(outbox[0].change.id).toBe('out1');
    expect(outbox[0].change.op).toBe(OperationType.Put);
    expect(outbox[0].change.clientId).toBe(db.clientId);
    expect(outbox[0].change.data).toEqual({ title: 'Outbox Test' });
  });

  it('should dynamically instantiate tables on demand', async () => {
    const dynamicTable = db.table<{ value: number }>('dynamic_metrics');
    await dynamicTable.put('cpu', { value: 42 });

    const retrieved = await dynamicTable.get('cpu');
    expect(retrieved?.value).toBe(42);
  });

  it('should manage and persist sync metadata (lastSyncSeq, tokens)', async () => {
    await db.idb.setMeta('lastSyncSeq', 12345);
    const seq = await db.idb.getMeta<number>('lastSyncSeq');
    expect(seq).toBe(12345);

    await db.idb.setMeta('authToken', 'sample.jwt.token');
    const token = await db.idb.getMeta<string>('authToken');
    expect(token).toBe('sample.jwt.token');

    await db.idb.deleteMeta('authToken');
    const deletedToken = await db.idb.getMeta<string>('authToken');
    expect(deletedToken).toBeUndefined();
  });

  it('should expose clientId and name', () => {
    expect(db.clientId).toBeDefined();
    expect(typeof db.clientId).toBe('string');
    expect(db.name).toBeDefined();
    expect(db.name.startsWith('test-db-')).toBe(true);
  });

  it('should require name on database initialization', () => {
    expect(
      () =>
        new TetherClient({
          name: '',
        } as unknown as { name: string }),
    ).toThrow('Missing required name in TetherClient options.');
  });

  it('should default appId to name when appId is not specified', async () => {
    const autoAppDb = new TetherClient({
      name: 'auto-app-db',
    });
    expect(autoAppDb.name).toBe('auto-app-db');
    expect(autoAppDb.appId).toBe('auto-app-db');
    await autoAppDb.close();
  });

  it('should allow custom appId override separate from name', async () => {
    const customAppDb = new TetherClient({
      name: 'custom_idb_name',
      appId: 'my-app',
    });
    expect(customAppDb.name).toBe('custom_idb_name');
    expect(customAppDb.appId).toBe('my-app');
    await customAppDb.close();
  });

  it('should infer basePath and webSocketPath by default mirroring server options', async () => {
    // Default: basePath is '', webSocketPath is '/sync'
    const defaultClient = new TetherClient({
      name: 'default-paths-app',
    });
    expect(defaultClient.basePath).toBe('');
    expect(defaultClient.webSocketPath).toBe('/sync');
    await defaultClient.close();

    // Base path without leading/trailing slash: normalized to '/api', webSocketPath inferred as '/api/sync'
    const apiApp = new TetherClient({
      name: 'api-app',
      basePath: 'api',
    });
    expect(apiApp.basePath).toBe('/api');
    expect(apiApp.webSocketPath).toBe('/api/sync');
    await apiApp.close();

    // Nested base path with slashes: normalized to '/api/v1', webSocketPath inferred as '/api/v1/sync'
    const v1App = new TetherClient({
      name: 'v1-app',
      basePath: '/api/v1/',
    });
    expect(v1App.basePath).toBe('/api/v1');
    expect(v1App.webSocketPath).toBe('/api/v1/sync');
    await v1App.close();

    // Explicit webSocketPath override
    const customWsApp = new TetherClient({
      name: 'custom-ws-app',
      basePath: '/api',
      webSocketPath: '/custom-socket',
    });
    expect(customWsApp.basePath).toBe('/api');
    expect(customWsApp.webSocketPath).toBe('/custom-socket');
    await customWsApp.close();

    // Host, port, and isSecure options
    const secureClient = new TetherClient({
      name: 'secure-app',
      host: 'api.example.com',
      port: 8443,
      isSecure: true,
      basePath: '/v1',
    });

    expect(secureClient.host).toBe('api.example.com');
    expect(secureClient.port).toBe(8443);
    expect(secureClient.isSecure).toBe(true);
    expect(secureClient.httpOrigin).toBe('https://api.example.com:8443');
    expect(secureClient.webSocketUrl).toBe(
      'wss://api.example.com:8443/v1/sync',
    );
    await secureClient.close();
  });

  it('should clear table contents completely using table.clear()', async () => {
    const table = db.table<{ name: string }>('tags');
    await table.putAll([
      { id: 't1', data: { name: 'work' } },
      { id: 't2', data: { name: 'personal' } },
      { id: 't3', data: { name: 'urgent' } },
    ]);

    expect(await table.getAll()).toHaveLength(3);
    const clearedCount = await table.clear();
    expect(clearedCount).toBe(3);
    expect(await table.getAll()).toHaveLength(0);
    expect(await table.getAllWithMetadata()).toHaveLength(0);
  });
});
