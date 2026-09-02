import { TETHER_PREFIX } from '../storage/utils.js';
import type { TableChangeEvent } from '../table.js';

/**
 * Cross-tab message broadcast over a named BroadcastChannel.
 * Carries either table mutation events or authentication lifecycle state transitions.
 */
export type TabMessage =
  | {
      type: 'auth';
      status: 'signedIn';
      userName: string;
      token: string;
    }
  | {
      type: 'auth';
      status: 'signedOut';
    }
  | {
      type: 'change';
      table: string;
      events: TableChangeEvent[];
    };

/** Callback invoked when a cross-tab message is received. */
export type TabMessageHandler = (msg: TabMessage) => void;

/**
 * Thin wrapper around `BroadcastChannel` that scopes cross-tab messages to a
 * specific TetherDB database name. Sibling tabs on the same database name
 * coordinate mutation updates and authentication lifecycle events in real time.
 *
 * Degrades gracefully to a no-op when `BroadcastChannel` is unavailable
 * (e.g. Node.js test environments or older browsers).
 */
export class TabChannel {
  private channel: BroadcastChannel | null = null;
  private readonly handlers: Set<TabMessageHandler> = new Set();

  /**
   * Creates a new TabChannel scoped to the given database name.
   *
   * @param databaseName - The IndexedDB database name used to scope the channel.
   */
  constructor(databaseName: string) {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(`${TETHER_PREFIX}${databaseName}`);
      this.channel.onmessage = (event: MessageEvent<TabMessage>) => {
        const msg = event.data;
        for (const handler of this.handlers) {
          try {
            handler(msg);
          } catch (err) {
            console.error('Unhandled TabChannel message error:', err);
          }
        }
      };
    }
  }

  /**
   * Broadcasts a message to all sibling tabs on the same database.
   * No-op when BroadcastChannel is unavailable.
   *
   * @param message - The TabMessage payload to broadcast.
   */
  broadcast(message: TabMessage): void {
    if (!this.channel) return;
    if (message.type === 'change' && message.events.length === 0) return;
    try {
      this.channel.postMessage(message);
    } catch {
      // Structured clone failures or closed channels are silently ignored.
    }
  }

  /**
   * Registers a handler to be called whenever a cross-tab message is received.
   * Returns an unsubscribe function.
   *
   * @param handler - Callback receiving the incoming tab message.
   * @returns Unsubscribe function that removes the handler.
   */
  onMessage(handler: TabMessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Closes the underlying BroadcastChannel and removes all message handlers.
   */
  destroy(): void {
    this.handlers.clear();
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
      this.channel = null;
    }
  }
}
