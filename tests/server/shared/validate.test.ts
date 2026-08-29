import { describe, expect, it } from 'vitest';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/errors.js';
import {
  calculateByteSize,
  getUserBucket,
  MAX_PASSWORD_LENGTH,
  MAX_USER_NAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USER_NAME_LENGTH,
  normalizeUserName,
  validateIdentifier,
  validatePassword,
  validateRecordId,
  validateTableName,
  validateTimestamp,
  validateUserId,
  validateUserName,
} from '../../../src/server/shared/validate.js';

describe('Validation', () => {
  describe('validateUserId', () => {
    it('should accept valid user identifiers', () => {
      expect(validateUserId('213872ac-54f2-4cd6-924e-204050bf7396')).toBe(
        '213872ac-54f2-4cd6-924e-204050bf7396',
      );
      expect(validateUserId('user_123-abc')).toBe('user_123-abc');
      expect(validateUserId('u')).toBe('u');
      expect(validateUserId('a'.repeat(64))).toBe('a'.repeat(64));
    });

    it('should reject invalid or malicious user identifiers', () => {
      expect(() => validateUserId('')).toThrow(TetherServerError);
      expect(() => validateUserId('')).toThrow('Invalid user ID');
      expect(() => validateUserId('a'.repeat(65))).toThrow(TetherServerError);
      expect(() => validateUserId('../user')).toThrow(TetherServerError);
      expect(() => validateUserId('user/123')).toThrow(TetherServerError);
      expect(() => validateUserId('user.name')).toThrow(TetherServerError);
      expect(() => validateUserId('user@domain')).toThrow(TetherServerError);
      // @ts-expect-error Testing non-string handling
      expect(() => validateUserId(null)).toThrow(TetherServerError);
      // @ts-expect-error Testing non-string handling
      expect(() => validateUserId(undefined)).toThrow(TetherServerError);

      try {
        validateUserId('');
      } catch (err) {
        expect((err as TetherServerError).code).toBe(
          TetherServerErrorCode.InvalidInput,
        );
      }
    });
  });

  describe('validateTableName', () => {
    it('should accept valid table names (including keywords)', () => {
      expect(validateTableName('todos')).toBe('todos');
      expect(validateTableName('user_notes-2026')).toBe('user_notes-2026');
      expect(validateTableName('__proto__')).toBe('__proto__');
      expect(validateTableName('meta')).toBe('meta');
      expect(validateTableName('changelog')).toBe('changelog');
    });

    it('should reject path traversal or invalid table names', () => {
      expect(() => validateTableName('../etc')).toThrow(TetherServerError);
      expect(() => validateTableName('../etc')).toThrow('Invalid table name');
      expect(() => validateTableName('table/name')).toThrow(TetherServerError);
      expect(() => validateTableName('table.name')).toThrow(TetherServerError);
      expect(() => validateTableName('')).toThrow(TetherServerError);
      expect(() => validateTableName('a'.repeat(65))).toThrow(
        TetherServerError,
      );
      // @ts-expect-error Testing non-string handling
      expect(() => validateTableName(null)).toThrow(TetherServerError);
      // @ts-expect-error Testing non-string handling
      expect(() => validateTableName(undefined)).toThrow(TetherServerError);
    });
  });

  describe('validateRecordId', () => {
    it('should accept valid record IDs (including keys and symbols)', () => {
      expect(validateRecordId('task-123')).toBe('task-123');
      expect(validateRecordId('a:b:c')).toBe('a:b:c');
      expect(validateRecordId('__proto__')).toBe('__proto__');
      expect(validateRecordId('prototype')).toBe('prototype');
      expect(validateRecordId('a'.repeat(256))).toBe('a'.repeat(256));
    });

    it('should reject empty or overly long record IDs or non-string inputs', () => {
      expect(() => validateRecordId('')).toThrow(TetherServerError);
      expect(() => validateRecordId('')).toThrow('Invalid record ID');
      expect(() => validateRecordId('x'.repeat(257))).toThrow(
        TetherServerError,
      );
      // @ts-expect-error Testing non-string handling
      expect(() => validateRecordId(null)).toThrow(TetherServerError);
      // @ts-expect-error Testing non-string handling
      expect(() => validateRecordId(undefined)).toThrow(TetherServerError);
    });
  });

  describe('normalizeUserName', () => {
    it('should trim whitespace and convert to lowercase', () => {
      expect(normalizeUserName('  Alice  ')).toBe('alice');
      expect(normalizeUserName('Bob_Builder-99.X')).toBe('bob_builder-99.x');
    });

    it('should safely handle non-string or empty inputs', () => {
      expect(normalizeUserName('')).toBe('');
      // @ts-expect-error Testing runtime non-string handling
      expect(normalizeUserName(null)).toBe('');
      // @ts-expect-error Testing runtime non-string handling
      expect(normalizeUserName(undefined)).toBe('');
    });
  });

  describe('validateUserName', () => {
    it('should accept valid usernames (including emails, symbols, keywords) and normalize to lowercase', () => {
      expect(validateUserName('  Alice  ')).toBe('alice');
      expect(validateUserName('user@example.com')).toBe('user@example.com');
      expect(validateUserName('John.Doe-99_x')).toBe('john.doe-99_x');
      expect(validateUserName('user with spaces')).toBe('user with spaces');
      expect(validateUserName('__proto__')).toBe('__proto__');
      expect(validateUserName('PROTOTYPE')).toBe('prototype');
      expect(validateUserName('Constructor')).toBe('constructor');
      expect(validateUserName('a'.repeat(MIN_USER_NAME_LENGTH))).toBe('aaa');
      expect(validateUserName('bob')).toBe('bob');
      expect(validateUserName('a'.repeat(MAX_USER_NAME_LENGTH))).toBe(
        'a'.repeat(128),
      );
    });

    it('should reject usernames outside the min/max length boundaries', () => {
      expect(() => validateUserName('a')).toThrow(TetherServerError);
      expect(() => validateUserName('a')).toThrow('between 3 and 128');
      expect(() => validateUserName('ab')).toThrow(TetherServerError);
      expect(() => validateUserName('')).toThrow(TetherServerError);
      expect(() =>
        validateUserName('a'.repeat(MAX_USER_NAME_LENGTH + 1)),
      ).toThrow(TetherServerError);
    });

    it('should reject non-string username inputs', () => {
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validateUserName(null)).toThrow(TetherServerError);
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validateUserName(undefined)).toThrow(TetherServerError);
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validateUserName(12345)).toThrow(TetherServerError);
    });
  });

  describe('validatePassword', () => {
    it('should accept valid passwords', () => {
      expect(validatePassword('secret123')).toBe('secret123');
      expect(validatePassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBe('aaaa');
      expect(validatePassword('a'.repeat(MAX_PASSWORD_LENGTH))).toBe(
        'a'.repeat(512),
      );
    });

    it('should reject empty or null or undefined passwords', () => {
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validatePassword(null)).toThrow(TetherServerError);
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validatePassword(undefined)).toThrow(TetherServerError);
      expect(() => validatePassword('')).toThrow(TetherServerError);
      expect(() => validatePassword('')).toThrow('between 4 and 512');
      expect(() => validatePassword('abc')).toThrow(TetherServerError);
      expect(() =>
        validatePassword('a'.repeat(MAX_PASSWORD_LENGTH + 1)),
      ).toThrow(TetherServerError);
    });
  });

  describe('validateIdentifier', () => {
    it('should accept valid identifiers', () => {
      expect(validateIdentifier('batch_123', 'batchId')).toBe('batch_123');
    });

    it('should reject invalid identifiers', () => {
      expect(() => validateIdentifier('', 'batchId')).toThrow(
        TetherServerError,
      );
      expect(() => validateIdentifier('', 'batchId')).toThrow(
        'Invalid batchId',
      );
      expect(() => validateIdentifier('b@tch!', 'batchId')).toThrow(
        TetherServerError,
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
      const circular: { self?: unknown } = {};
      circular.self = circular;
      expect(calculateByteSize(circular)).toBe(0);
    });
  });

  describe('getUserBucket', () => {
    it('should calculate 2-character hex/hash bucket', () => {
      expect(getUserBucket('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe('f4');
      expect(getUserBucket('0a1b2c3d')).toBe('0a');
      expect(getUserBucket('user_42')).toBe('us');
      expect(getUserBucket('A1-test')).toBe('a1');
      expect(getUserBucket('x')).toBe('0x');
    });
  });

  describe('validateTimestamp', () => {
    it('should accept reasonable current and past timestamps', () => {
      const now = Date.now();
      expect(validateTimestamp(now)).toBe(now);
      expect(validateTimestamp(now - 60_000)).toBe(now - 60_000);
      expect(validateTimestamp(now + 60_000)).toBe(now + 60_000); // 1 minute in future is within 5 min limit
    });

    it('should reject invalid, non-finite, or non-positive timestamps', () => {
      // @ts-expect-error Testing non-number handling
      expect(() => validateTimestamp('invalid')).toThrow(TetherServerError);
      expect(() => validateTimestamp(Number.NaN)).toThrow(TetherServerError);
      expect(() => validateTimestamp(Number.POSITIVE_INFINITY)).toThrow(
        TetherServerError,
      );
      expect(() => validateTimestamp(0)).toThrow(TetherServerError);
      expect(() => validateTimestamp(-1000)).toThrow(TetherServerError);
    });

    it('should reject timestamps that exceed the maximum allowable future drift', () => {
      const farFuture = Date.now() + 10 * 60 * 1000; // 10 minutes in future (> 5 min limit)
      expect(() => validateTimestamp(farFuture)).toThrow(TetherServerError);
      expect(() => validateTimestamp(farFuture)).toThrow(
        'Timestamp drift exceeds maximum allowable threshold',
      );
    });
  });
});
