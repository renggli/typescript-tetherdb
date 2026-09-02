import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { MemoryStorage } from '../../src/server/storage/memory.js';
import { Sync } from '../../src/server/sync.js';
import {
  ClientMessageType,
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

describe('Sync Re-Authentication under Connection Limit', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('permits re-authentication on the same WebSocket connection when concurrency limit is 1', async () => {
    const sync = new Sync(storage, { maxConcurrentConnectionsPerUser: 1 });
    const ws = new MockWebSocket();
    const user = await storage.createUser('alice', 'Password123!');
    const token = await user.createToken();

    sync.handleConnection(ws as unknown as WebSocket);

    // 1st Auth
    ws.emit(
      'message',
      JSON.stringify({
        type: ClientMessageType.Auth,
        protocolVersion: PROTOCOL_VERSION,
        token,
        clientId: 'client_1',
      }),
    );

    await ws.waitForMessages(2);
    expect(JSON.parse(ws.sentMessages[0]).type).toBe(
      ServerMessageType.AuthSuccess,
    );

    // 2nd Auth on same socket (e.g. token refresh)
    ws.emit(
      'message',
      JSON.stringify({
        type: ClientMessageType.Auth,
        protocolVersion: PROTOCOL_VERSION,
        token,
        clientId: 'client_1',
      }),
    );

    await ws.waitForMessages(4);
    expect(JSON.parse(ws.sentMessages[2]).type).toBe(
      ServerMessageType.AuthSuccess,
    );
    expect(ws.isClosed).toBe(false);
  });
});
