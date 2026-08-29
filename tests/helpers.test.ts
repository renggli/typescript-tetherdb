import { describe, expect, it } from 'vitest';
import { delay, waitForCondition } from './helpers.js';

describe('delay', () => {
  it('should pause execution for at least the specified duration', async () => {
    const start = Date.now();
    await delay(10);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(8);
  });
});

describe('waitForCondition', () => {
  it('should resolve immediately if predicate is already true', async () => {
    let checks = 0;
    await waitForCondition(() => {
      checks++;
      return true;
    });
    expect(checks).toBe(1);
  });

  it('should resolve when asynchronous predicate eventually returns true', async () => {
    let counter = 0;
    await waitForCondition(
      async () => {
        counter++;
        return counter >= 3;
      },
      1000,
      2,
    );
    expect(counter).toBe(3);
  });

  it('should throw an error when condition times out', async () => {
    await expect(waitForCondition(() => false, 20, 5)).rejects.toThrow(
      'waitForCondition timed out after 20ms',
    );
  });
});
