import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket as NodeWebSocket } from 'ws';
import { TetherDB } from '../../src/client/db.js';
import { startServer, TetherServer } from '../../src/server/server.js';
import { MemoryStorageAdapter } from '../../src/server/storage/memory.js';
import { OperationType } from '../../src/shared/types.js';

describe('Multi-Application Support & Server Discovery (src/client/)', () => {
  let tmpDir: string;
  let server: TetherServer;
  let port: number;
  let serverUrl: string;
  let closeServer: (() => Promise<void>) | null = null;
  const activeClients: TetherDB[] = [];

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-multiapp-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });

    server = new TetherServer({
      storageDir: tmpDir,
    });

    const httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;
    serverUrl = `http://127.0.0.1:${port}`;
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
    const db1 = new TetherDB({
      name: `test_todo_app_${Date.now()}`,
      appId: 'todo-app',
    });
    activeClients.push(db1);

    const auth = await db1.register({
      serverUrl,
      username: 'multi_user',
      password: 'password123',
      WebSocketClass: NodeWebSocket,
    });

    const todoTable = db1.table<{ title: string }>('items');
    await todoTable.put('todo_1', { title: 'First Todo Item' });

    // Wait for sync flush
    await new Promise((r) => setTimeout(r, 100));

    // 2. Open a separate application database for the same user
    const db2 = new TetherDB({
      name: `test_notes_app_${Date.now()}`,
      appId: 'notes-app',
    });
    activeClients.push(db2);

    await db2.login({
      serverUrl,
      username: 'multi_user',
      password: 'password123',
      WebSocketClass: NodeWebSocket,
    });

    const notesTable = db2.table<{ title: string }>('items');
    await notesTable.put('note_1', { title: 'First Note Item' });

    // Wait for sync flush
    await new Promise((r) => setTimeout(r, 100));

    // 3. Verify Todo app has only todo_1, Notes app has only note_1
    const todoRecords = await todoTable.getAll();
    expect(todoRecords).toHaveLength(1);
    expect(todoRecords[0]?.title).toBe('First Todo Item');

    const noteRecords = await notesTable.getAll();
    expect(noteRecords).toHaveLength(1);
    expect(noteRecords[0]?.title).toBe('First Note Item');

    // 4. Verify server discovery APIs
    const apps = await server.storageAdapter.listApps(auth.userId);
    expect(apps).toEqual(['notes-app', 'todo-app']);

    const todoStores = await server.storageAdapter.listStores(
      auth.userId,
      'todo-app',
    );
    expect(todoStores).toEqual(['items']);

    const noteStores = await server.storageAdapter.listStores(
      auth.userId,
      'notes-app',
    );
    expect(noteStores).toEqual(['items']);
  });

  it('should support HTTP discovery endpoints GET /apps and GET /apps/:appId/tables', async () => {
    // Register and create data in 'chat-app' and 'docs-app'
    const db = new TetherDB({
      name: `test_discovery_${Date.now()}`,
      appId: 'chat-app',
    });
    activeClients.push(db);

    const auth = await db.register({
      serverUrl,
      username: 'discovery_user',
      password: 'password123',
      WebSocketClass: NodeWebSocket,
    });

    await db.table('messages').put('m1', { text: 'Hello' });
    await db.table('channels').put('c1', { name: 'general' });

    await new Promise((r) => setTimeout(r, 100));

    // Public list apps endpoint
    const appsRes = await fetch(`${serverUrl}/apps`);
    expect(appsRes.ok).toBe(true);
    const appsData = (await appsRes.json()) as { apps: string[] };
    expect(appsData.apps).toContain('chat-app');

    // Authenticated list tables endpoint
    const tablesRes = await fetch(`${serverUrl}/apps/chat-app/tables`, {
      headers: {
        Authorization: `Bearer ${auth.token}`,
      },
    });
    expect(tablesRes.ok).toBe(true);
    const tablesData = (await tablesRes.json()) as {
      appId: string;
      tables: string[];
    };
    expect(tablesData.appId).toBe('chat-app');
    expect(tablesData.tables).toEqual(['channels', 'messages']);
  });

  it('should isolate real-time broadcasts so mutations in appA do not trigger subscribers in appB', async () => {
    // App A client 1
    const clientA1 = new TetherDB({
      name: `appA_c1_${Date.now()}`,
      appId: 'app-alpha',
    });
    activeClients.push(clientA1);

    await clientA1.register({
      serverUrl,
      username: 'broadcast_user',
      password: 'password123',
      WebSocketClass: NodeWebSocket,
    });

    // App A client 2 (same app, same user)
    const clientA2 = new TetherDB({
      name: `appA_c2_${Date.now()}`,
      appId: 'app-alpha',
    });
    activeClients.push(clientA2);
    await clientA2.login({
      serverUrl,
      username: 'broadcast_user',
      password: 'password123',
      WebSocketClass: NodeWebSocket,
    });

    // App B client 1 (different app, same user)
    const clientB1 = new TetherDB({
      name: `appB_c1_${Date.now()}`,
      appId: 'app-beta',
    });
    activeClients.push(clientB1);
    await clientB1.login({
      serverUrl,
      username: 'broadcast_user',
      password: 'password123',
      WebSocketClass: NodeWebSocket,
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

  it('should work correctly with MemoryStorageAdapter for multi-app storage', async () => {
    const memory = new MemoryStorageAdapter();
    const userId = 'user_mem_123';

    await memory.applyChanges(
      userId,
      [
        {
          store: 'settings',
          id: 's1',
          op: OperationType.Put,
          data: { theme: 'dark' },
          timestamp: 100,
          clientId: 'c1',
        },
      ],
      'app-one',
    );

    await memory.applyChanges(
      userId,
      [
        {
          store: 'settings',
          id: 's1',
          op: OperationType.Put,
          data: { theme: 'light' },
          timestamp: 200,
          clientId: 'c2',
        },
      ],
      'app-two',
    );

    const appOneRecord = await memory.getRecord(
      userId,
      'settings',
      's1',
      'app-one',
    );
    expect(appOneRecord?.data).toEqual({ theme: 'dark' });

    const appTwoRecord = await memory.getRecord(
      userId,
      'settings',
      's1',
      'app-two',
    );
    expect(appTwoRecord?.data).toEqual({ theme: 'light' });

    const apps = await memory.listApps(userId);
    expect(apps).toEqual(['app-one', 'app-two']);

    const appOneStores = await memory.listStores(userId, 'app-one');
    expect(appOneStores).toEqual(['settings']);
  });

  it('should start and shut down cleanly via startServer helper', async () => {
    const runner = await startServer({
      port: 0,
      host: '127.0.0.1',
      storageDir: path.join(tmpDir, 'startServerTest'),
    });

    expect(runner.port).toBeGreaterThan(0);
    const res = await fetch(`http://${runner.host}:${runner.port}/health`);
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');

    await runner.close();
  });
});
