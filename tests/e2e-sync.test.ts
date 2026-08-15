import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { BeamedClientDB } from '../src/client/db.js';
import { BeamedServer } from '../src/server/server.js';
import { OperationType } from '../src/shared/types.js';

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('End-to-End WebSocket Sync', () => {
  let server: BeamedServer;
  let wsUrl: string;
  let tmpDir: string;
  let userToken: string;
  let port: number;

  beforeEach(async () => {
    port = 9000 + Math.floor(Math.random() * 1000);
    tmpDir = path.join(
      os.tmpdir(),
      `beameddb-e2e-${Math.random().toString(36).substring(2, 8)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });

    server = new BeamedServer({
      storageDir: tmpDir,
    });

    await server.listen(port, '127.0.0.1');
    wsUrl = `ws://127.0.0.1:${port}/sync`;

    // Register user
    const res = await server.auth.register('testuser', 'password123');
    userToken = res.token;
  });

  afterEach(async () => {
    await server.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should sync local changes from Client A to server', async () => {
    const clientA = new BeamedClientDB({
      name: `client-a-${Math.random().toString(36).substring(2, 8)}`,
      stores: ['todos'],
      sync: {
        url: wsUrl,
        token: userToken,
        WebSocketClass: WebSocket,
      },
    });

    const todosA = clientA.table<{ title: string; done: boolean }>('todos');
    await todosA.put('t1', { title: 'Buy groceries', done: false });

    // Wait for sync to flush
    await delay(200);

    const session = server.auth.verifyToken(userToken);
    const serverRecords = await server.storageAdapter.getAllRecords(
      session?.userId ?? '',
    );
    expect(serverRecords).toHaveLength(1);
    expect(serverRecords[0].data).toEqual({
      title: 'Buy groceries',
      done: false,
    });

    await clientA.close();
  });

  it('should perform initial snapshot sync on new client connection', async () => {
    // Client A creates data
    const clientA = new BeamedClientDB({
      name: `client-a-${Math.random().toString(36).substring(2, 8)}`,
      stores: ['todos'],
      sync: {
        url: wsUrl,
        token: userToken,
        WebSocketClass: WebSocket,
      },
    });

    const todosA = clientA.table<{ title: string; done: boolean }>('todos');
    await todosA.put('t1', { title: 'Write code', done: false });
    await todosA.put('t2', { title: 'Run tests', done: true });

    await delay(200);
    await clientA.close();

    // Client B connects from clean state
    const clientB = new BeamedClientDB({
      name: `client-b-${Math.random().toString(36).substring(2, 8)}`,
      stores: ['todos'],
      sync: {
        url: wsUrl,
        token: userToken,
        WebSocketClass: WebSocket,
      },
    });

    // Wait for connection and snapshot delivery
    await delay(200);

    const todosB = clientB.table<{ title: string; done: boolean }>('todos');
    const allB = await todosB.getAll();
    expect(allB).toHaveLength(2);
    expect(allB.map((t) => t.title).sort()).toEqual([
      'Run tests',
      'Write code',
    ]);

    await clientB.close();
  });

  it('should broadcast real-time changes between concurrent clients', async () => {
    const clientA = new BeamedClientDB({
      name: `client-a-${Math.random().toString(36).substring(2, 8)}`,
      stores: ['messages'],
      sync: {
        url: wsUrl,
        token: userToken,
        WebSocketClass: WebSocket,
      },
    });

    const clientB = new BeamedClientDB({
      name: `client-b-${Math.random().toString(36).substring(2, 8)}`,
      stores: ['messages'],
      sync: {
        url: wsUrl,
        token: userToken,
        WebSocketClass: WebSocket,
      },
    });

    await delay(150);

    const messagesB = clientB.table<{ text: string }>('messages');
    const receivedEvents: Array<{
      op: OperationType;
      id: string;
      data?: { text: string };
      isRemote?: boolean;
    }> = [];
    messagesB.subscribe((event) => {
      receivedEvents.push(event);
    });

    const messagesA = clientA.table<{ text: string }>('messages');
    await messagesA.put('msg-1', { text: 'Hello from Client A!' });

    await delay(200);

    expect(receivedEvents).toHaveLength(1);
    expect(receivedEvents[0].op).toBe(OperationType.Put);
    expect(receivedEvents[0].isRemote).toBe(true);
    expect(receivedEvents[0].data).toEqual({ text: 'Hello from Client A!' });

    const fetchedFromB = await messagesB.get('msg-1');
    expect(fetchedFromB).toEqual({ text: 'Hello from Client A!' });

    await clientA.close();
    await clientB.close();
  });

  it('should catch up with diff sync after being offline', async () => {
    const clientA = new BeamedClientDB({
      name: `client-a-${Math.random().toString(36).substring(2, 8)}`,
      stores: ['items'],
      sync: {
        url: wsUrl,
        token: userToken,
        WebSocketClass: WebSocket,
      },
    });

    const itemsA = clientA.table<{ name: string }>('items');
    await itemsA.put('item-1', { name: 'First' });
    await delay(200);

    // Client B connects and gets initial sync
    const clientBName = `client-b-${Math.random().toString(36).substring(2, 8)}`;
    let clientB = new BeamedClientDB({
      name: clientBName,
      stores: ['items'],
      sync: {
        url: wsUrl,
        token: userToken,
        WebSocketClass: WebSocket,
      },
    });

    await delay(200);
    const itemsB1 = clientB.table<{ name: string }>('items');
    expect(await itemsB1.getAll()).toHaveLength(1);

    // Client B disconnects (simulating going offline)
    await clientB.close();

    // Client A makes more changes while B is offline
    await itemsA.put('item-2', { name: 'Second' });
    await itemsA.put('item-3', { name: 'Third' });
    await delay(200);

    // Client B comes back online with the same IndexedDB database
    clientB = new BeamedClientDB({
      name: clientBName,
      stores: ['items'],
      sync: {
        url: wsUrl,
        token: userToken,
        WebSocketClass: WebSocket,
      },
    });

    await delay(250);

    const itemsB2 = clientB.table<{ name: string }>('items');
    const all = await itemsB2.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((i) => i.name).sort()).toEqual(['First', 'Second', 'Third']);

    await clientA.close();
    await clientB.close();
  });

  it('should enforce multi-tenant isolation across users', async () => {
    const user2 = await server.auth.register('otheruser', 'password123');

    const clientUser1 = new BeamedClientDB({
      name: `client-u1-${Math.random().toString(36).substring(2, 8)}`,
      stores: ['docs'],
      sync: {
        url: wsUrl,
        token: userToken,
        WebSocketClass: WebSocket,
      },
    });

    const clientUser2 = new BeamedClientDB({
      name: `client-u2-${Math.random().toString(36).substring(2, 8)}`,
      stores: ['docs'],
      sync: {
        url: wsUrl,
        token: user2.token,
        WebSocketClass: WebSocket,
      },
    });

    await delay(150);

    const docs1 = clientUser1.table<{ secret: string }>('docs');
    await docs1.put('doc1', { secret: 'top secret 1' });

    await delay(200);

    const docs2 = clientUser2.table<{ secret: string }>('docs');
    const all2 = await docs2.getAll();
    expect(all2).toHaveLength(0);

    await clientUser1.close();
    await clientUser2.close();
  });
});
