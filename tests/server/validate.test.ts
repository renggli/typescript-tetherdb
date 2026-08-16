import { describe, expect, it } from 'vitest';
import {
  calculateByteSize,
  getUserBucket,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  normalizeUsername,
  validateAppId,
  validateIdentifier,
  validatePassword,
  validateRecordId,
  validateTableName,
  validateUserId,
  validateUsername,
} from '../../src/server/validate.js';

describe('src/server/validate.ts', () => {
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
      expect(() => validateUserId('')).toThrow('Invalid user ID');
      expect(() => validateUserId('a'.repeat(65))).toThrow('Invalid user ID');
      expect(() => validateUserId('../user')).toThrow('Invalid user ID');
      expect(() => validateUserId('user/123')).toThrow('Invalid user ID');
      expect(() => validateUserId('user.name')).toThrow('Invalid user ID');
      expect(() => validateUserId('user@domain')).toThrow('Invalid user ID');
      // @ts-expect-error Testing non-string handling
      expect(() => validateUserId(null)).toThrow('Invalid user ID');
      // @ts-expect-error Testing non-string handling
      expect(() => validateUserId(undefined)).toThrow('Invalid user ID');
    });
  });

  describe('validateAppId', () => {
    it('should accept valid filesystem-safe app identifiers', () => {
      expect(validateAppId('my-app_v1')).toBe('my-app_v1');
      expect(validateAppId('default')).toBe('default');
      expect(validateAppId('users')).toBe('users');
      expect(validateAppId('__proto__')).toBe('__proto__');
    });

    it('should reject invalid app IDs (dots, slashes, spaces, empty, traversal)', () => {
      expect(() => validateAppId('../app')).toThrow('Invalid application ID');
      expect(() => validateAppId('app/123')).toThrow('Invalid application ID');
      expect(() => validateAppId('my-app.v1')).toThrow(
        'Invalid application ID',
      );
      expect(() => validateAppId('')).toThrow('Invalid application ID');
      expect(() => validateAppId('a'.repeat(65))).toThrow(
        'Invalid application ID',
      );
      // @ts-expect-error Testing non-string handling
      expect(() => validateAppId(null)).toThrow('Invalid application ID');
      // @ts-expect-error Testing non-string handling
      expect(() => validateAppId(undefined)).toThrow('Invalid application ID');
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
      expect(() => validateTableName('../etc')).toThrow('Invalid table name');
      expect(() => validateTableName('table/name')).toThrow(
        'Invalid table name',
      );
      expect(() => validateTableName('table.name')).toThrow(
        'Invalid table name',
      );
      expect(() => validateTableName('')).toThrow('Invalid table name');
      expect(() => validateTableName('a'.repeat(65))).toThrow(
        'Invalid table name',
      );
      // @ts-expect-error Testing non-string handling
      expect(() => validateTableName(null)).toThrow('Invalid table name');
      // @ts-expect-error Testing non-string handling
      expect(() => validateTableName(undefined)).toThrow('Invalid table name');
    });
  });

  describe('validateRecordId', () => {
    it('should accept valid record IDs (including keys and symbols)', () => {
      expect(validateRecordId('task-123')).toBe('task-123');
      expect(validateRecordId('a:b:c')).toBe('a:b:c');
      expect(validateRecordId('__proto__')).toBe('__proto__');
      expect(validateRecordId('prototype')).toBe('prototype');
      expect(validateRecordId('a'.repeat(512))).toBe('a'.repeat(512));
    });

    it('should reject empty or overly long record IDs or non-string inputs', () => {
      expect(() => validateRecordId('')).toThrow('Invalid record ID');
      expect(() => validateRecordId('x'.repeat(513))).toThrow(
        'Invalid record ID',
      );
      // @ts-expect-error Testing non-string handling
      expect(() => validateRecordId(null)).toThrow('Invalid record ID');
      // @ts-expect-error Testing non-string handling
      expect(() => validateRecordId(undefined)).toThrow('Invalid record ID');
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
    it('should accept valid usernames (including emails, symbols, keywords) and normalize to lowercase', () => {
      expect(validateUsername('  Alice  ')).toBe('alice');
      expect(validateUsername('user@example.com')).toBe('user@example.com');
      expect(validateUsername('John.Doe-99_x')).toBe('john.doe-99_x');
      expect(validateUsername('user with spaces')).toBe('user with spaces');
      expect(validateUsername('__proto__')).toBe('__proto__');
      expect(validateUsername('PROTOTYPE')).toBe('prototype');
      expect(validateUsername('Constructor')).toBe('constructor');
      expect(validateUsername('a'.repeat(MIN_USERNAME_LENGTH))).toBe('aaaa');
      expect(validateUsername('a'.repeat(MAX_USERNAME_LENGTH))).toBe(
        'a'.repeat(128),
      );
    });

    it('should reject usernames outside the min/max length boundaries', () => {
      expect(() => validateUsername('a')).toThrow('between 4 and 128');
      expect(() => validateUsername('abc')).toThrow('between 4 and 128');
      expect(() => validateUsername('')).toThrow('between 4 and 128');
      expect(() =>
        validateUsername('a'.repeat(MAX_USERNAME_LENGTH + 1)),
      ).toThrow('between 4 and 128');
    });

    it('should reject non-string username inputs', () => {
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validateUsername(null)).toThrow('must be a string');
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validateUsername(undefined)).toThrow('must be a string');
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validateUsername(12345)).toThrow('must be a string');
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
      expect(() => validatePassword(null)).toThrow('non-empty string');
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validatePassword(undefined)).toThrow('non-empty string');
      expect(() => validatePassword('')).toThrow('between 4 and 512');
      expect(() => validatePassword('abc')).toThrow('between 4 and 512');
      expect(() =>
        validatePassword('a'.repeat(MAX_PASSWORD_LENGTH + 1)),
      ).toThrow('between 4 and 512');
    });
  });

  describe('validateIdentifier', () => {
    it('should accept valid identifiers', () => {
      expect(validateIdentifier('batch_123', 'batchId')).toBe('batch_123');
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

  describe('getUserBucket', () => {
    it('should calculate 2-character hex/hash bucket', () => {
      expect(getUserBucket('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe('f4');
      expect(getUserBucket('0a1b2c3d')).toBe('0a');
      expect(getUserBucket('user_42')).toBe('us');
      expect(getUserBucket('A1-test')).toBe('a1');
      expect(getUserBucket('x')).toBe('0x');
    });
  });
});
