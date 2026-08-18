/**
 * Type of callback listener registered with an EventRegistry.
 *
 * @typeParam T - The event payload type.
 */
export type EventListener<T = void> = (event: T) => void;

/**
 * A lightweight typed event registry managing subscriber registration and event publishing.
 *
 * @typeParam T - The event payload type (defaults to void for parameterless events).
 */
export class EventRegistry<T = void> {
  private readonly listeners: Set<EventListener<T>> = new Set();

  /**
   * Registers a callback listener to be notified when events are published.
   *
   * @param listener - Callback function receiving event payloads.
   * @returns An unregister function that removes the listener.
   */
  register(listener: EventListener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Dispatches an event payload to all registered listeners in registration order.
   * Catches and logs listener exceptions to prevent aborting dispatch to remaining listeners.
   *
   * @param args - The event data payload (optional if payload type is void).
   */
  publish(...args: T extends void ? [event?: T] : [event: T]): void {
    const event = args[0] as T;
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('Unhandled error:', err);
      }
    }
  }
}
