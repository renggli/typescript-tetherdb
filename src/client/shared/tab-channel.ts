import { EventRegistry } from '../../shared/event.js';
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

/**
 * Thin wrapper around `BroadcastChannel` that scopes cross-tab messages to a
 * specific TetherDB database name. Sibling tabs on the same database name
 * coordinate mutation updates and authentication lifecycle events in real time.
 *
 * Degrades gracefully to a no-op when `BroadcastChannel` is unavailable
 * (e.g. Node.js test environments or older browsers).
 */
export class TabChannel {
  /** Reactive event registry triggered whenever a message is received from a sibling tab. */
  readonly onMessage = new EventRegistry<TabMessage>();

  private channel: BroadcastChannel | null = null;

  /**
   * Creates a new TabChannel scoped to the given database name.
   *
   * @param databaseName - The IndexedDB database name used to scope the channel.
   */
  constructor(databaseName: string) {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(`${TETHER_PREFIX}${databaseName}`);
      this.channel.onmessage = (event: MessageEvent<TabMessage>) => {
        this.onMessage.publish(event.data);
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
   * Closes the underlying BroadcastChannel.
   */
  destroy(): void {
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.close();
      this.channel = null;
    }
  }
}
