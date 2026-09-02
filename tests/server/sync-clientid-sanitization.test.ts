import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { TetherServerError } from '../../src/server/errors.js';
import { MemoryStorage } from '../../src/server/storage/memory.js';
import { validateBatchChanges } from '../../src/server/storage/storage.js';
import { Sync } from '../../src/server/sync.js';
import {
  type ChangeRecord,
  ClientMessageType,
  OperationType,
  Permission,
  PROTOCOL_VERSION,
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

describe('Sync and Storage ClientId Sanitization', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('sanitizes change.clientId with authenticated connection clientId in handleChangeBatchMessage', async () => {
    const sync = new Sync(storage);
    const ws = new MockWebSocket();
    const table = await storage.createTable('audit_logs', {
      permissions: {
        read: Permission.Everybody,
        create: Permission.Everybody,
        update: Permission.Everybody,
        delete: Permission.Everybody,
      },
    });

    sync.handleConnection(ws as unknown as WebSocket);

    ws.emit(
      'message',
      JSON.stringify({
        type: ClientMessageType.Auth,
        protocolVersion: PROTOCOL_VERSION,
        clientId: 'genuine_client_123',
      }),
    );

    await ws.waitForMessages(2);

    // Submit batch with spoofed clientId
    ws.emit(
      'message',
      JSON.stringify({
        type: ClientMessageType.ChangeBatch,
        batchId: 'batch1',
        changes: [
          {
            table: table.name,
            id: 'log1',
            op: OperationType.Put,
            clientId: 'spoofed_client_id_zzzzz',
            data: { event: 'test' },
            timestamp: 1000,
          },
        ],
      }),
    );

    await ws.waitForMessages(3);
    const record = await table.getRecord(undefined, 'log1');
    expect(record?.clientId).toBe('genuine_client_123');
  });

  it('validates change.clientId in validateBatchChanges if provided', async () => {
    await storage.createTable('items');
    const badChanges: ChangeRecord[] = [
      {
        table: 'items',
        id: 'i1',
        op: OperationType.Put,
        clientId: '../traversal_bad_id',
        data: {},
        timestamp: 1000,
      },
    ];

    await expect(validateBatchChanges(storage, badChanges)).rejects.toThrow(
      TetherServerError,
    );
  });
});
