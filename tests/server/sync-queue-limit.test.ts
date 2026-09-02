import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { MemoryStorage } from '../../src/server/storage/memory.js';
import { Sync } from '../../src/server/sync.js';

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

describe('Sync Message Queue Buffer Limit', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('terminates socket when queued message byte limit is exceeded', async () => {
    const sync = new Sync(storage);
    const ws = new MockWebSocket();
    sync.handleConnection(ws as unknown as WebSocket);

    // Send a message that exceeds the 10MB limit
    const hugePayload = 'X'.repeat(11 * 1024 * 1024);
    ws.emit('message', hugePayload);

    await ws.waitForClose(1000);
    expect(ws.isClosed).toBe(true);
  });
});
