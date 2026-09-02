import { describe, expect, it } from 'vitest';
import { EventRegistry } from '../../src/shared/event.js';
import { testLogger } from '../logger.js';

describe('EventRegistry', () => {
  it('should register listeners and dispatch events', () => {
    interface TestEvent {
      id: string;
      value: number;
    }

    const registry = new EventRegistry<TestEvent>();
    const received: TestEvent[] = [];

    const unregister = registry.register((event) => {
      received.push(event);
    });

    registry.publish({ id: 'e1', value: 42 });
    registry.publish({ id: 'e2', value: 100 });

    expect(received).toEqual([
      { id: 'e1', value: 42 },
      { id: 'e2', value: 100 },
    ]);

    unregister();

    registry.publish({ id: 'e3', value: 200 });
    expect(received).toHaveLength(2);
  });

  it('should support void parameterless events', () => {
    const registry = new EventRegistry<void>();
    let count = 0;

    const unregister = registry.register(() => {
      count++;
    });

    registry.publish();
    registry.publish();
    expect(count).toBe(2);

    unregister();
    registry.publish();
    expect(count).toBe(2);
  });

  it('should support multiple independent listeners', () => {
    const registry = new EventRegistry<string>();
    const callsA: string[] = [];
    const callsB: string[] = [];

    const unregA = registry.register((msg) => callsA.push(msg));
    const unregB = registry.register((msg) => callsB.push(msg));

    registry.publish('hello');
    expect(callsA).toEqual(['hello']);
    expect(callsB).toEqual(['hello']);

    unregA();

    registry.publish('world');
    expect(callsA).toEqual(['hello']);
    expect(callsB).toEqual(['hello', 'world']);

    unregB();
    registry.publish('after all');
    expect(callsB).toEqual(['hello', 'world']);
  });

  it('should isolate listener errors and continue notifying remaining listeners', () => {
    const registry = new EventRegistry<number>();
    const handled: number[] = [];

    registry.register(() => {
      throw new Error('Listener exploded');
    });
    registry.register((val) => {
      handled.push(val);
    });

    expect(() => registry.publish(123)).not.toThrow();
    expect(handled).toEqual([123]);
    expect(testLogger.hasMessage(/Unhandled error/, 'error')).toBe(true);
  });
});
