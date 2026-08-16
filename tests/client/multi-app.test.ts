import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { TetherClient } from '../../src/client/client.js';
import { startServer, TetherServer } from '../../src/server/server.js';
import { FileStorage } from '../../src/server/storage/file/index.js';
import { MemoryStorage } from '../../src/server/storage/index.js';
import { OperationType } from '../../src/shared/types.js';

describe('Multi-Application Support & Server Discovery (src/client/)', () => {
  let tmpDir: string;
  let server: TetherServer;
  let port: number;
  let closeServer: (() => Promise<void>) | null = null;
  const activeClients: TetherClient[] = [];

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-multiapp-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });

    server = new TetherServer({
      storage: new FileStorage({ baseDir: tmpDir }),
    });
    await server.declareApp('todo-app', ['items']);
    await server.declareApp('notes-app', ['items']);
    await server.declareApp('chat-app', ['channels', 'messages']);
    await server.declareApp('docs-app', ['pages']);
    await server.declareApp('app-alpha', ['feed']);
    await server.declareApp('app-beta', ['feed']);

    const httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
    closeServer = () => server.close();
  });

  afterEach(async () => {
    for (const client of activeClients) {
      client.disableSync();
      await client.close();
    }
    activeClients.length = 0;

    if (closeServer) {
      await closeServer();
      closeServer = null;
    }

    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Cleanup best effort
    }
  });

  it('should isolate data across different applications for the same user', async () => {
    // 1. Register user
    const db1 = new TetherClient({
      name: `test_todo_app_${Date.now()}`,
      appId: 'todo-app',
      host: '127.0.0.1',
      port,
      WebSocketClass: NodeWebSocket,
    });
    activeClients.push(db1);

    const success1 = await db1.register({
      username: 'multi_user',
      password: 'password123',
    });
    expect(success1).toBe(true);

    const todoTable = db1.table<{ title: string }>('items');
    await todoTable.put('todo_1', { title: 'First Todo Item' });

    // Wait for sync flush
    await new Promise((r) => setTimeout(r, 100));

    // 2. Open a separate application database for the same user
    const db2 = new TetherClient({
      name: `test_notes_app_${Date.now()}`,
      appId: 'notes-app',
      host: '127.0.0.1',
      port,
      WebSocketClass: NodeWebSocket,
    });
    activeClients.push(db2);

    const success2 = await db2.login({
      username: 'multi_user',
      password: 'password123',
    });
    expect(success2).toBe(true);

    const notesTable = db2.table<{ title: string }>('items');
    await notesTable.put('note_1', { title: 'First Note Item' });

    // Wait for sync flush
    await new Promise((r) => setTimeout(r, 100));

    // 3. Verify data isolation
    const todoRecords = await todoTable.getAll();
    expect(todoRecords).toHaveLength(1);
    expect(todoRecords[0]?.title).toBe('First Todo Item');

    const noteRecords = await notesTable.getAll();
    expect(noteRecords).toHaveLength(1);
    expect(noteRecords[0]?.title).toBe('First Note Item');

    // 4. Verify server storage isolation
    const apps = await server.storage.getApps();
    expect(apps.map((a) => a.id)).toContain('notes-app');
    expect(apps.map((a) => a.id)).toContain('todo-app');

    // Check todo-app data
    const user = await server.storage.getUserByUsername('multi_user');
    expect(user).toBeDefined();
    if (!user) return;
    const todoApp = await server.storage.getApp('todo-app');
    const todosTable = await todoApp?.getTable('items');
    const todoRecordsList = (await todosTable?.getAllRecords(user)) ?? [];
    expect(todoRecordsList).toHaveLength(1);

    // Check notes-app data
    const noteApp = await server.storage.getApp('notes-app');
    expect(noteApp).toBeDefined();
    const noteTables = (await noteApp?.getTables()) ?? [];
    expect(noteTables.map((t) => t.name)).toEqual(['items']);
  });

  it('should isolate real-time broadcasts so mutations in appA do not trigger subscribers in appB', async () => {
    // App A client 1
    const clientA1 = new TetherClient({
      name: `appA_c1_${Date.now()}`,
      appId: 'app-alpha',
      host: '127.0.0.1',
      port,
      WebSocketClass: NodeWebSocket,
    });
    activeClients.push(clientA1);

    await clientA1.register({
      username: 'broadcast_user',
      password: 'password123',
    });

    // App A client 2 (same app, same user)
    const clientA2 = new TetherClient({
      name: `appA_c2_${Date.now()}`,
      appId: 'app-alpha',
      host: '127.0.0.1',
      port,
      WebSocketClass: NodeWebSocket,
    });
    activeClients.push(clientA2);
    await clientA2.login({
      username: 'broadcast_user',
      password: 'password123',
    });

    // App B client 1 (different app, same user)
    const clientB1 = new TetherClient({
      name: `appB_c1_${Date.now()}`,
      appId: 'app-beta',
      host: '127.0.0.1',
      port,
      WebSocketClass: NodeWebSocket,
    });
    activeClients.push(clientB1);
    await clientB1.login({
      username: 'broadcast_user',
      password: 'password123',
    });

    const receivedA2: string[] = [];
    clientA2.table<{ text: string }>('feed').subscribe((events) => {
      for (const e of events) {
        if (e.data?.text) receivedA2.push(e.data.text);
      }
    });

    const receivedB1: string[] = [];
    clientB1.table<{ text: string }>('feed').subscribe((events) => {
      for (const e of events) {
        if (e.data?.text) receivedB1.push(e.data.text);
      }
    });

    // Mutate in App A
    await clientA1
      .table<{ text: string }>('feed')
      .put('f1', { text: 'Alpha Feed 1' });

    // Wait for WebSocket broadcast
    await new Promise((r) => setTimeout(r, 200));

    expect(receivedA2).toContain('Alpha Feed 1');
    expect(receivedB1).toHaveLength(0); // Beta received zero events from Alpha!
  });

  it('should work correctly with MemoryStorage for multi-app storage', async () => {
    const memory = new MemoryStorage();
    const appOne = await memory.createApp('app-one');
    const tableOne = await appOne.createTable('settings');
    const appTwo = await memory.createApp('app-two');
    const tableTwo = await appTwo.createTable('settings');
    const user = await memory.createUser('user_mem_123', 'pass');

    await tableOne.applyChanges(user, [
      {
        table: 'settings',
        id: 's1',
        op: OperationType.Put,
        data: { theme: 'dark' },
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    await tableTwo.applyChanges(user, [
      {
        table: 'settings',
        id: 's1',
        op: OperationType.Put,
        data: { theme: 'light' },
        timestamp: 200,
        clientId: 'c2',
      },
    ]);

    const appOneRecord = await tableOne.getRecord(user, 's1');
    expect(appOneRecord?.data).toEqual({ theme: 'dark' });

    const appTwoRecord = await tableTwo.getRecord(user, 's1');
    expect(appTwoRecord?.data).toEqual({ theme: 'light' });

    const apps = await memory.getApps();
    expect(apps.map((a) => a.id)).toEqual(['app-one', 'app-two']);

    const appOneTables = await appOne.getTables();
    expect(appOneTables.map((t) => t.name)).toEqual(['settings']);
  });

  it('should start and shut down cleanly via startServer helper', async () => {
    const runner = await startServer({
      port: 0,
      host: '127.0.0.1',
      storage: new FileStorage({
        baseDir: path.join(tmpDir, 'startServerTest'),
      }),
    });

    expect(runner.port).toBeGreaterThan(0);
    const regRes = await fetch(
      `http://${runner.host}:${runner.port}/auth/register`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'starter_user',
          password: 'password123',
        }),
      },
    );
    expect(regRes.ok).toBe(true);
    const body = (await regRes.json()) as { userId: string; username: string };
    expect(body.username).toBe('starter_user');

    await runner.close();
  });
});
