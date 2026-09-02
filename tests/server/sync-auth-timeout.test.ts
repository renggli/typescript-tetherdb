import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { MemoryStorage } from '../../src/server/storage/memory.js';
import { Sync } from '../../src/server/sync.js';
import {
  ClientMessageType,
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

  async waitForClose(timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!this.isClosed) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timeout waiting for websocket close');
      }
      await new Promise((r) => setTimeout(r, 2));
    }
  }
}

describe('Sync Auth Timeout', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('maintains auth timeout active across failed login attempts until valid auth or timeout', async () => {
    const sync = new Sync(storage, { authTimeoutMs: 50 });
    const ws = new MockWebSocket();
    sync.handleConnection(ws as unknown as WebSocket);

    // Send an invalid login attempt
    ws.emit(
      'message',
      JSON.stringify({
        type: ClientMessageType.Login,
        userName: 'nonexistent',
        password: 'wrongpassword',
        requestId: 'req-1',
      }),
    );

    await ws.waitForMessages(1);
    const authErrorMsg = JSON.parse(ws.sentMessages[0]);
    expect(authErrorMsg.type).toBe(ServerMessageType.AuthError);

    // Auth timeout should still fire after 50ms and close the connection
    await ws.waitForClose(500);
    expect(ws.isClosed).toBe(true);
    const timeoutMsg = JSON.parse(ws.sentMessages[1]);
    expect(timeoutMsg.message).toBe('Authentication timeout');
  });
});
