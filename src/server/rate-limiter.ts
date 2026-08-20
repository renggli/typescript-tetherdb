/**
 * Configuration options for a RateLimiter instance.
 */
export interface RateLimiterOptions {
  /** Time window in milliseconds (defaults to 60,000ms / 1 minute). */
  windowMs?: number;
  /** Maximum number of allowed requests within the time window. */
  maxRequests?: number;
  /** Number of consecutive failures before applying progressive backoff (defaults to 3). */
  maxFailures?: number;
  /** Initial backoff duration in milliseconds after exceeding maxFailures (defaults to 1,000ms). */
  initialBackoffMs?: number;
  /** Maximum backoff duration in milliseconds (defaults to 900,000ms / 15 minutes). */
  maxBackoffMs?: number;
}

/**
 * In-memory sliding-window rate limiter with failure-based exponential backoff.
 */
export class RateLimiter {
  private readonly store = new Map<string, RateLimitEntry>();
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly maxFailures: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  /**
   * Initializes a new RateLimiter instance.
   *
   * @param options - Configuration options for window size, request limits, and backoff.
   */
  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequests = options.maxRequests ?? 60;
    this.maxFailures = options.maxFailures ?? 3;
    this.initialBackoffMs = options.initialBackoffMs ?? 1_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 900_000;
  }

  /**
   * Checks whether the given key is currently rate limited or blocked by backoff cooldown.
   *
   * @param key - Identifier (e.g. IP address or username).
   * @param now - Current timestamp in milliseconds (defaults to Date.now()).
   * @returns `true` if requests for this key are limited; `false` otherwise.
   */
  isLimited(key: string, now = Date.now()): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;

    if (entry.blockedUntil > now) {
      return true;
    }

    if (entry.resetAt <= now) {
      this.store.delete(key);
      return false;
    }

    return entry.count >= this.maxRequests;
  }

  /**
   * Consumes one attempt for the given key if not currently limited.
   *
   * @param key - Identifier.
   * @param now - Current timestamp in milliseconds.
   * @returns `true` if request was allowed and consumed; `false` if rate limited.
   */
  consume(key: string, now = Date.now()): boolean {
    if (this.isLimited(key, now)) {
      return false;
    }

    const entry = this.store.get(key);
    if (!entry || (entry.resetAt <= now && entry.blockedUntil <= now)) {
      this.store.set(key, {
        count: 1,
        resetAt: now + this.windowMs,
        failures: 0,
        blockedUntil: 0,
      });
      return true;
    }

    entry.count++;
    return true;
  }

  /**
   * Records a failed attempt for the given key and applies progressive exponential backoff.
   *
   * @param key - Identifier.
   * @param now - Current timestamp in milliseconds.
   * @returns Cooldown duration in milliseconds if blocked, or 0 if under failure threshold.
   */
  recordFailure(key: string, now = Date.now()): number {
    let entry = this.store.get(key);
    if (!entry || (entry.resetAt <= now && entry.blockedUntil <= now)) {
      entry = {
        count: 1,
        resetAt: now + this.windowMs,
        failures: 0,
        blockedUntil: 0,
      };
      this.store.set(key, entry);
    }

    entry.failures++;

    if (entry.failures >= this.maxFailures) {
      const exponent = entry.failures - this.maxFailures;
      const backoff = Math.min(
        this.initialBackoffMs * 2 ** exponent,
        this.maxBackoffMs,
      );
      entry.blockedUntil = now + backoff;
      return backoff;
    }

    return 0;
  }

  /**
   * Resets all failure counters and request tracking for the given key.
   *
   * @param key - Identifier to reset.
   */
  reset(key: string): void {
    this.store.delete(key);
  }

  /**
   * Clears all stored rate limit entries.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Purges expired entries from the internal store.
   *
   * @param now - Current timestamp in milliseconds.
   */
  cleanup(now = Date.now()): void {
    for (const [key, entry] of this.store.entries()) {
      if (entry.resetAt <= now && entry.blockedUntil <= now) {
        this.store.delete(key);
      }
    }
  }
}

// -- Private Helpers --------------------------------------------------------

interface RateLimitEntry {
  count: number;
  resetAt: number;
  failures: number;
  blockedUntil: number;
}
