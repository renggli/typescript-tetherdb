import { describe, expect, it } from 'vitest';
import {
  calculateByteSize,
  MAX_USERNAME_LENGTH,
  MIN_USERNAME_LENGTH,
  normalizeUsername,
  parseAllowedSpec,
  validateAppAndTable,
  validateIdentifier,
  validateRecordId,
  validateTableName,
  validateUserId,
  validateUsername,
} from '../../src/shared/sanitize.js';

describe('src/shared/sanitize.ts', () => {
  describe('validateUserId', () => {
    it('should accept valid user identifiers', () => {
      expect(validateUserId('213872ac-54f2-4cd6-924e-204050bf7396')).toBe(
        '213872ac-54f2-4cd6-924e-204050bf7396',
      );
      expect(validateUserId('user_123-abc')).toBe('user_123-abc');
    });

    it('should reject invalid or malicious user identifiers', () => {
      expect(() => validateUserId('')).toThrow('Invalid user ID');
      expect(() => validateUserId('a')).toThrow('Invalid user ID');
      expect(() => validateUserId('../user')).toThrow('Invalid user ID');
      expect(() => validateUserId('user/123')).toThrow('Invalid user ID');
      expect(() => validateUserId('user.name')).toThrow('Invalid user ID');
      expect(() => validateUserId('user@domain')).toThrow('Invalid user ID');
    });
  });

  describe('validateTableName', () => {
    it('should accept valid table names', () => {
      expect(validateTableName('todos')).toBe('todos');
      expect(validateTableName('user_notes-2026')).toBe('user_notes-2026');
    });

    it('should enforce allowlist if specified', () => {
      const allowed = ['todos', 'notes'];
      expect(validateTableName('todos', allowed, 'u1')).toBe('todos');
      expect(() => validateTableName('secrets', allowed, 'u1')).toThrow(
        'Table "secrets" is not in the allowed tables list for user "u1"',
      );
    });

    it('should reject reserved system keywords', () => {
      expect(() => validateTableName('__proto__')).toThrow(
        'reserved system keyword',
      );
      expect(() => validateTableName('prototype')).toThrow(
        'reserved system keyword',
      );
      expect(() => validateTableName('meta')).toThrow(
        'reserved system keyword',
      );
      expect(() => validateTableName('changelog')).toThrow(
        'reserved system keyword',
      );
    });

    it('should reject path traversal table names', () => {
      expect(() => validateTableName('../etc')).toThrow('Invalid table name');
      expect(() => validateTableName('table/name')).toThrow(
        'Invalid table name',
      );
    });
  });

  describe('validateRecordId', () => {
    it('should accept safe record IDs', () => {
      expect(validateRecordId('task-123')).toBe('task-123');
      expect(validateRecordId('a:b:c')).toBe('a:b:c');
    });

    it('should reject empty or overly long record IDs', () => {
      expect(() => validateRecordId('')).toThrow('Invalid record ID');
      expect(() => validateRecordId('x'.repeat(513))).toThrow(
        'Invalid record ID',
      );
    });

    it('should reject null bytes and prototype keys', () => {
      expect(() => validateRecordId('test\0bad')).toThrow(
        'forbidden characters',
      );
      expect(() => validateRecordId('__proto__')).toThrow(
        'forbidden characters',
      );
      expect(() => validateRecordId('prototype')).toThrow(
        'forbidden characters',
      );
    });
  });

  describe('normalizeUsername', () => {
    it('should trim whitespace and convert to lowercase', () => {
      expect(normalizeUsername('  Alice  ')).toBe('alice');
      expect(normalizeUsername('Bob_Builder-99.X')).toBe('bob_builder-99.x');
    });

    it('should safely handle non-string or empty inputs', () => {
      expect(normalizeUsername('')).toBe('');
      // @ts-expect-error Testing runtime non-string handling
      expect(normalizeUsername(null)).toBe('');
      // @ts-expect-error Testing runtime non-string handling
      expect(normalizeUsername(undefined)).toBe('');
    });
  });

  describe('validateUsername', () => {
    it('should accept valid usernames, normalize to lowercase, and trim whitespace', () => {
      expect(validateUsername('  Alice  ')).toBe('alice');
      expect(validateUsername('John.Doe-99_x')).toBe('john.doe-99_x');
      expect(validateUsername('a'.repeat(MIN_USERNAME_LENGTH))).toBe('aa');
      expect(validateUsername('a'.repeat(MAX_USERNAME_LENGTH))).toBe(
        'a'.repeat(64),
      );
    });

    it('should reject usernames outside the min/max length boundaries', () => {
      expect(() => validateUsername('a')).toThrow('between 2 and 64');
      expect(() => validateUsername('')).toThrow('between 2 and 64');
      expect(() =>
        validateUsername('a'.repeat(MAX_USERNAME_LENGTH + 1)),
      ).toThrow('between 2 and 64');
    });

    it('should reject non-string username inputs', () => {
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validateUsername(null)).toThrow('must be a string');
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validateUsername(undefined)).toThrow('must be a string');
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validateUsername(12345)).toThrow('must be a string');
    });

    it('should reject reserved or invalid characters in usernames', () => {
      expect(() => validateUsername('user space')).toThrow('Invalid username');
      expect(() => validateUsername('user@domain.com')).toThrow(
        'Invalid username',
      );
      expect(() => validateUsername('../traversal')).toThrow(
        'Invalid username',
      );
      expect(() => validateUsername('__proto__')).toThrow('reserved keyword');
      expect(() => validateUsername('PROTOTYPE')).toThrow('reserved keyword');
      expect(() => validateUsername('Constructor')).toThrow('reserved keyword');
    });
  });

  describe('validateIdentifier', () => {
    it('should accept valid identifiers', () => {
      expect(validateIdentifier('batch_123', 'batchId', 'u1')).toBe(
        'batch_123',
      );
    });

    it('should reject invalid identifiers', () => {
      expect(() => validateIdentifier('', 'batchId')).toThrow(
        'Invalid batchId',
      );
      expect(() => validateIdentifier('b@tch!', 'batchId')).toThrow(
        'Invalid batchId',
      );
    });
  });

  describe('calculateByteSize', () => {
    it('should calculate sizes for primitive types', () => {
      expect(calculateByteSize(null)).toBe(0);
      expect(calculateByteSize(undefined)).toBe(0);
      expect(calculateByteSize('hello')).toBe(5);
      expect(calculateByteSize(42)).toBe(8);
      expect(calculateByteSize(true)).toBe(4);
    });

    it('should calculate sizes for structured objects and handle circular safely', () => {
      const obj = { title: 'Test', count: 10 };
      expect(calculateByteSize(obj)).toBeGreaterThan(10);

      // Circular reference safely falls back to 0 without crashing
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(calculateByteSize(circular)).toBe(0);
    });
  });

  describe('parseAllowedSpec', () => {
    it('should parse semicolon and colon separated app and table lists', () => {
      const parsed = parseAllowedSpec(
        'app2:table1,table2;app1:table3,table4,table5',
      );
      expect(parsed).toBeDefined();
      expect(parsed?.get('app2')).toEqual(new Set(['table1', 'table2']));
      expect(parsed?.get('app1')).toEqual(
        new Set(['table3', 'table4', 'table5']),
      );
    });

    it('should allow app without tables restriction', () => {
      const parsed = parseAllowedSpec('app1;app2:t1');
      expect(parsed?.get('app1')).toEqual(new Set());
      expect(parsed?.get('app2')).toEqual(new Set(['t1']));
    });

    it('should return undefined for empty or whitespace spec', () => {
      expect(parseAllowedSpec()).toBeUndefined();
      expect(parseAllowedSpec('')).toBeUndefined();
      expect(parseAllowedSpec('   ')).toBeUndefined();
    });
  });

  describe('validateAppAndTable', () => {
    it('should validate allowed apps and table permissions', () => {
      const allowedApps = parseAllowedSpec('app1:t1,t2;app2:t3');
      const limits = { allowedApps };

      expect(validateAppAndTable('app1', 't1', limits, 'u1')).toEqual({
        safeAppId: 'app1',
        safeTableName: 't1',
      });

      expect(() => validateAppAndTable('app3', 't1', limits, 'u1')).toThrow(
        'not in the allowed applications list',
      );

      expect(() => validateAppAndTable('app1', 't3', limits, 'u1')).toThrow(
        'not in the allowed tables list',
      );
    });
  });
});
