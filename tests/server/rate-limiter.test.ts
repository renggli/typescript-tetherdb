import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/server/rate-limiter.js';

describe('RateLimiter', () => {
  it('should allow requests within maxRequests limit', () => {
    const limiter = new RateLimiter({ windowMs: 10_000, maxRequests: 3 });

    expect(limiter.isLimited('user1')).toBe(false);
    expect(limiter.consume('user1')).toBe(true);
    expect(limiter.consume('user1')).toBe(true);
    expect(limiter.consume('user1')).toBe(true);

    expect(limiter.isLimited('user1')).toBe(true);
    expect(limiter.consume('user1')).toBe(false);

    // Other keys should not be affected
    expect(limiter.isLimited('user2')).toBe(false);
    expect(limiter.consume('user2')).toBe(true);
  });

  it('should reset limits when window expires', () => {
    const limiter = new RateLimiter({ windowMs: 1_000, maxRequests: 2 });
    const now = 100_000;

    expect(limiter.consume('user1', now)).toBe(true);
    expect(limiter.consume('user1', now + 100)).toBe(true);
    expect(limiter.isLimited('user1', now + 200)).toBe(true);

    // After window expires (100_000 + 1_000)
    expect(limiter.isLimited('user1', now + 1_001)).toBe(false);
    expect(limiter.consume('user1', now + 1_001)).toBe(true);
  });

  it('should apply progressive backoff on consecutive failures', () => {
    const limiter = new RateLimiter({
      windowMs: 60_000,
      maxRequests: 10,
      maxFailures: 3,
      initialBackoffMs: 1_000,
      maxBackoffMs: 16_000,
    });
    const now = 100_000;

    // Failures 1 and 2: no backoff cooldown yet
    expect(limiter.recordFailure('alice', now)).toBe(0);
    expect(limiter.isLimited('alice', now)).toBe(false);

    expect(limiter.recordFailure('alice', now)).toBe(0);
    expect(limiter.isLimited('alice', now)).toBe(false);

    // Failure 3 (maxFailures): backoff starts at 1,000ms (1s)
    const backoff3 = limiter.recordFailure('alice', now);
    expect(backoff3).toBe(1_000);
    expect(limiter.isLimited('alice', now)).toBe(true);
    expect(limiter.isLimited('alice', now + 999)).toBe(true);
    expect(limiter.isLimited('alice', now + 1_001)).toBe(false);

    // Failure 4: exponential backoff increases to 2,000ms (2s)
    const backoff4 = limiter.recordFailure('alice', now + 1_001);
    expect(backoff4).toBe(2_000);
    expect(limiter.isLimited('alice', now + 2_000)).toBe(true);
    expect(limiter.isLimited('alice', now + 3_002)).toBe(false);

    // Failure 5: 4,000ms (4s)
    const backoff5 = limiter.recordFailure('alice', now + 3_002);
    expect(backoff5).toBe(4_000);

    // Failure 6: 8,000ms (8s)
    const backoff6 = limiter.recordFailure('alice', now + 7_003);
    expect(backoff6).toBe(8_000);

    // Failure 7: 16,000ms (capped at maxBackoffMs)
    const backoff7 = limiter.recordFailure('alice', now + 15_004);
    expect(backoff7).toBe(16_000);
  });

  it('should reset limits and failures on successful authentication reset()', () => {
    const limiter = new RateLimiter({
      windowMs: 60_000,
      maxRequests: 5,
      maxFailures: 2,
    });
    const now = 100_000;

    limiter.recordFailure('bob', now);
    limiter.recordFailure('bob', now);
    expect(limiter.isLimited('bob', now)).toBe(true);

    limiter.reset('bob');
    expect(limiter.isLimited('bob', now)).toBe(false);
    expect(limiter.consume('bob', now)).toBe(true);
  });

  it('should purge expired entries on cleanup() and clear()', () => {
    const limiter = new RateLimiter({ windowMs: 1_000 });
    const now = 100_000;

    limiter.consume('user1', now);
    limiter.consume('user2', now + 500);

    limiter.cleanup(now + 1_100);
    // user1 is expired (> 1000ms window), user2 is not (> 500ms remaining)
    expect(limiter.isLimited('user1', now + 1_100)).toBe(false);

    limiter.clear();
    expect(limiter.isLimited('user2', now + 500)).toBe(false);
  });
});
