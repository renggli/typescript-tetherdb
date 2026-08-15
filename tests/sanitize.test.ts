import { describe, expect, it } from 'vitest';
import {
  calculateByteSize,
  validateIdentifier,
  validateRecordId,
  validateStoreName,
  validateUserId,
  validateUsername,
} from '../src/shared/sanitize.js';

describe('Sanitization and Security Validators', () => {
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

  describe('validateStoreName', () => {
    it('should accept valid store names', () => {
      expect(validateStoreName('todos')).toBe('todos');
      expect(validateStoreName('user_notes-2026')).toBe('user_notes-2026');
    });

    it('should enforce allowlist if specified', () => {
      const allowed = ['todos', 'notes'];
      expect(validateStoreName('todos', allowed, 'u1')).toBe('todos');
      expect(() => validateStoreName('secrets', allowed, 'u1')).toThrow(
        'Table "secrets" is not in the allowed tables list for user "u1"',
      );
    });

    it('should reject reserved system keywords', () => {
      expect(() => validateStoreName('__proto__')).toThrow(
        'reserved system keyword',
      );
      expect(() => validateStoreName('prototype')).toThrow(
        'reserved system keyword',
      );
      expect(() => validateStoreName('meta')).toThrow(
        'reserved system keyword',
      );
      expect(() => validateStoreName('changelog')).toThrow(
        'reserved system keyword',
      );
    });

    it('should reject path traversal store names', () => {
      expect(() => validateStoreName('../etc')).toThrow('Invalid table name');
      expect(() => validateStoreName('store/name')).toThrow(
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

  describe('validateUsername', () => {
    it('should accept valid usernames and trim whitespace', () => {
      expect(validateUsername(' alice ')).toBe('alice');
      expect(validateUsername('john.doe-99_x')).toBe('john.doe-99_x');
    });

    it('should reject reserved or invalid usernames', () => {
      expect(() => validateUsername('a')).toThrow('Invalid username');
      expect(() => validateUsername('user space')).toThrow('Invalid username');
      expect(() => validateUsername('__proto__')).toThrow('reserved keyword');
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
});
