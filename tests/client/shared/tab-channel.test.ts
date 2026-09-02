import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabChannel } from '../../../src/client/shared/tab-channel.js';
import { TETHER_PREFIX } from '../../../src/client/storage/utils.js';

describe('TabChannel', () => {
  let channel: TabChannel;

  afterEach(() => {
    channel.destroy();
  });

  describe('when BroadcastChannel is available', () => {
    beforeEach(() => {
      channel = new TabChannel('test-db');
    });

    it('registers and invokes message handlers for table changes', () => {
      const received: unknown[] = [];
      channel.onMessage((msg) => received.push(msg));

      const bc = new BroadcastChannel(`${TETHER_PREFIX}test-db`);
      bc.postMessage({
        type: 'change',
        table: 'todos',
        events: [{ id: 'a', op: 'put' }],
      });
      bc.close();

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(received).toHaveLength(1);
          expect(received[0]).toMatchObject({ type: 'change', table: 'todos' });
          resolve();
        }, 0);
      });
    });

    it('registers and invokes message handlers for auth sign-in events', () => {
      const received: unknown[] = [];
      channel.onMessage((msg) => received.push(msg));

      const bc = new BroadcastChannel(`${TETHER_PREFIX}test-db`);
      bc.postMessage({
        type: 'auth',
        status: 'signedIn',
        userName: 'alice',
        token: 'token-123',
      });
      bc.close();

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(received).toHaveLength(1);
          expect(received[0]).toEqual({
            type: 'auth',
            status: 'signedIn',
            userName: 'alice',
            token: 'token-123',
          });
          resolve();
        }, 0);
      });
    });

    it('registers and invokes message handlers for auth sign-out events', () => {
      const received: unknown[] = [];
      channel.onMessage((msg) => received.push(msg));

      const bc = new BroadcastChannel(`${TETHER_PREFIX}test-db`);
      bc.postMessage({
        type: 'auth',
        status: 'signedOut',
      });
      bc.close();

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(received).toHaveLength(1);
          expect(received[0]).toEqual({
            type: 'auth',
            status: 'signedOut',
          });
          resolve();
        }, 0);
      });
    });

    it('unsubscribes a handler via the returned function', () => {
      const received: unknown[] = [];
      const unsub = channel.onMessage((msg) => received.push(msg));
      unsub();

      const bc = new BroadcastChannel(`${TETHER_PREFIX}test-db`);
      bc.postMessage({ type: 'change', table: 'todos', events: [] });
      bc.close();

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(received).toHaveLength(0);
          resolve();
        }, 0);
      });
    });

    it('does not broadcast change message when events array is empty', () => {
      const received: unknown[] = [];
      const bc = new BroadcastChannel(`${TETHER_PREFIX}test-db`);
      bc.onmessage = (e) => received.push(e.data);

      channel.broadcast({ type: 'change', table: 'todos', events: [] });

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(received).toHaveLength(0);
          bc.close();
          resolve();
        }, 0);
      });
    });

    it('broadcasts events to sibling channels on the same database name', () => {
      const receiver = new TabChannel('test-db');
      const received: unknown[] = [];
      receiver.onMessage((msg) => received.push(msg));

      channel.broadcast({
        type: 'change',
        table: 'notes',
        events: [{ id: '1', op: 'put', data: { text: 'hi' } }],
      });

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(received).toHaveLength(1);
          expect(received[0]).toMatchObject({ type: 'change', table: 'notes' });
          receiver.destroy();
          resolve();
        }, 0);
      });
    });

    it('does not receive messages from a channel with a different database name', () => {
      const other = new TabChannel('other-db');
      const received: unknown[] = [];
      channel.onMessage((msg) => received.push(msg));

      other.broadcast({
        type: 'change',
        table: 'todos',
        events: [{ id: '1', op: 'delete' }],
      });

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(received).toHaveLength(0);
          other.destroy();
          resolve();
        }, 0);
      });
    });

    it('stops receiving messages after destroy()', () => {
      const received: unknown[] = [];
      channel.onMessage((msg) => received.push(msg));
      channel.destroy();

      const bc = new BroadcastChannel(`${TETHER_PREFIX}test-db`);
      bc.postMessage({ type: 'change', table: 'todos', events: [] });
      bc.close();

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(received).toHaveLength(0);
          resolve();
        }, 0);
      });
    });

    it('broadcast is a no-op after destroy()', () => {
      channel.destroy();
      expect(() => {
        channel.broadcast({
          type: 'change',
          table: 'todos',
          events: [{ id: '1', op: 'put' }],
        });
      }).not.toThrow();
    });
  });

  describe('when BroadcastChannel is unavailable', () => {
    let originalBroadcastChannel: typeof BroadcastChannel;

    beforeEach(() => {
      originalBroadcastChannel = globalThis.BroadcastChannel;
      // @ts-expect-error — simulating missing API
      globalThis.BroadcastChannel = undefined;
      channel = new TabChannel('test-db');
    });

    afterEach(() => {
      globalThis.BroadcastChannel = originalBroadcastChannel;
    });

    it('is created without errors', () => {
      expect(channel).toBeInstanceOf(TabChannel);
    });

    it('broadcast is a no-op and does not throw', () => {
      expect(() => {
        channel.broadcast({
          type: 'change',
          table: 'todos',
          events: [{ id: '1', op: 'put' }],
        });
      }).not.toThrow();
    });

    it('onMessage returns an unsubscribe function and does not throw', () => {
      const unsub = channel.onMessage(vi.fn());
      expect(typeof unsub).toBe('function');
      expect(() => unsub()).not.toThrow();
    });

    it('destroy does not throw', () => {
      expect(() => channel.destroy()).not.toThrow();
    });
  });
});
