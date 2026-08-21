import type { TetherLogger } from '../src/server/server.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'log';

/**
 * A recorded log entry in TestLogger.
 */
export interface LogEntry {
  /** Log level for this entry. */
  readonly level: LogLevel;
  /** Primary message string. */
  readonly message: string;
  /** Additional arguments passed to the logging call. */
  readonly args: readonly unknown[];
}

/**
 * In-memory test logger that suppresses console output and collects log items for test assertions.
 */
export class TestLogger implements TetherLogger {
  readonly entries: LogEntry[] = [];

  /**
   * Logs a standard output message.
   */
  log(message?: unknown, ...args: unknown[]): void {
    this.record('log', message, args);
  }

  /**
   * Logs debug information.
   */
  debug(message?: unknown, ...args: unknown[]): void {
    this.record('debug', message, args);
  }

  /**
   * Logs operational information.
   */
  info(message?: unknown, ...args: unknown[]): void {
    this.record('info', message, args);
  }

  /**
   * Logs warning conditions.
   */
  warn(message?: unknown, ...args: unknown[]): void {
    this.record('warn', message, args);
  }

  /**
   * Logs error conditions.
   */
  error(message?: unknown, ...args: unknown[]): void {
    this.record('error', message, args);
  }

  /**
   * Returns an array of all recorded log message strings.
   */
  get messages(): string[] {
    return this.entries.map((entry) => entry.message);
  }

  /**
   * Returns all entries matching the specified log level.
   */
  getByLevel(level: LogLevel): LogEntry[] {
    return this.entries.filter((entry) => entry.level === level);
  }

  /**
   * Checks whether any recorded log entry contains the specified substring or matches regex.
   */
  hasMessage(pattern: string | RegExp, level?: LogLevel): boolean {
    return this.entries.some((entry) => {
      if (level && entry.level !== level) {
        return false;
      }
      const serializedArgs = entry.args.map((arg) => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) {
          return `${arg.name}: ${arg.message} ${arg.stack ?? ''}`;
        }
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      });
      const text = [entry.message, ...serializedArgs].join(' ');
      return typeof pattern === 'string'
        ? text.includes(pattern)
        : pattern.test(text);
    });
  }

  /**
   * Clears all recorded log entries.
   */
  clear(): void {
    this.entries.length = 0;
  }

  private record(level: LogLevel, message: unknown, args: unknown[]): void {
    this.entries.push({
      level,
      message: String(message ?? ''),
      args,
    });
  }
}

/**
 * Global TestLogger instance used across test suites.
 */
export const testLogger = new TestLogger();
