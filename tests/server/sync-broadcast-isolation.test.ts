import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { MemoryStorage } from '../../src/server/storage/memory.js';
import { Sync } from '../../src/server/sync.js';
import {
  ClientMessageType,
  OperationType,
  Permission,
  PROTOCOL_VERSION,
  ServerMessageType,
} from '../../src/shared/types.js';

class MockWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;
  sentMessages: string[] = [];
  isClosed = false;

  send(data: string): void {
    this.sentMessages.push(data);
    this.emit('sent', data);
  }

  close(): void {
    this.readyState = this.CLOSED;
    this.isClosed = true;
    this.emit('close');
  }

  terminate(): void {
    this.close();
  }

  async waitForMessages(count = 1, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (this.sentMessages.length < count) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timeout waiting for ${count} messages (got ${this.sentMessages.length})`,
        );
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  }
}

describe('Sync Broadcast Isolation', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('broadcasts changes to peer connection even when sharing the same clientId string', async () => {
    const sync = new Sync(storage);
    const wsA = new MockWebSocket();
    const wsB = new MockWebSocket();

    const table = await storage.createTable('shared_feed', {
      permissions: {
        read: Permission.Everybody,
        create: Permission.Everybody,
        update: Permission.Everybody,
        delete: Permission.Everybody,
      },
    });

    sync.handleConnection(wsA as unknown as WebSocket);
    sync.handleConnection(wsB as unknown as WebSocket);

    // Both sockets authenticate with the same clientId
    wsA.emit(
      'message',
      JSON.stringify({
        type: ClientMessageType.Auth,
        protocolVersion: PROTOCOL_VERSION,
        clientId: 'shared_client_id_1',
      }),
    );
    wsB.emit(
      'message',
      JSON.stringify({
        type: ClientMessageType.Auth,
        protocolVersion: PROTOCOL_VERSION,
        clientId: 'shared_client_id_1',
      }),
    );

    await wsA.waitForMessages(2);
    await wsB.waitForMessages(2);

    // wsA sends a change batch
    wsA.emit(
      'message',
      JSON.stringify({
        type: ClientMessageType.ChangeBatch,
        batchId: 'b1',
        changes: [
          {
            table: table.name,
            id: 'item1',
            op: OperationType.Put,
            data: { title: 'Broadcast test' },
            timestamp: 1000,
          },
        ],
      }),
    );

    // wsA receives ChangeAck (total 3)
    await wsA.waitForMessages(3);

    // wsB MUST receive BroadcastChanges (total 3)
    await wsB.waitForMessages(3);
    const broadcastMsg = JSON.parse(wsB.sentMessages[2]);
    expect(broadcastMsg.type).toBe(ServerMessageType.BroadcastChanges);
    expect(broadcastMsg.changes[0].id).toBe('item1');
  });
});
