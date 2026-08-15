import { describe, expect, it } from 'vitest';
import {
  createUserAccount,
  generateSalt,
  generateSessionToken,
  generateTokenSecret,
  hashPassword,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MIN_USERNAME_LENGTH,
  normalizeUsername,
  validatePassword,
  validateUsername,
  verifyPassword,
  verifySessionToken,
} from '../../../src/server/auth/crypto.js';

describe('src/server/auth/crypto.ts', () => {
  describe('normalizeUsername', () => {
    it('should normalize usernames to lowercase and trimmed string', () => {
      expect(normalizeUsername('  Alice_123  ')).toBe('alice_123');
    });
  });

  describe('validateUsername', () => {
    it('should validate and normalize usernames within bounds', () => {
      expect(validateUsername('  BOB  ')).toBe('bob');
      expect(MIN_USERNAME_LENGTH).toBe(2);
      expect(MAX_USERNAME_LENGTH).toBe(64);
    });

    it('should reject usernames outside bounds', () => {
      expect(() => validateUsername('a')).toThrow('between 2 and 64');
    });
  });
  describe('validatePassword', () => {
    it('should accept valid passwords between min and max length', () => {
      expect(() => validatePassword('1234')).not.toThrow();
      expect(() =>
        validatePassword('a'.repeat(MIN_PASSWORD_LENGTH)),
      ).not.toThrow();
      expect(() =>
        validatePassword('a'.repeat(MAX_PASSWORD_LENGTH)),
      ).not.toThrow();
      expect(() => validatePassword('my-secure-password-!@#$%')).not.toThrow();
    });

    it('should reject passwords shorter than minimum length', () => {
      expect(() => validatePassword('')).toThrow('between 4 and 1024');
      expect(() => validatePassword('1')).toThrow('between 4 and 1024');
      expect(() => validatePassword('123')).toThrow('between 4 and 1024');
    });

    it('should reject passwords longer than maximum length', () => {
      expect(() =>
        validatePassword('a'.repeat(MAX_PASSWORD_LENGTH + 1)),
      ).toThrow('between 4 and 1024');
    });

    it('should reject non-string password inputs', () => {
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validatePassword(null)).toThrow('between 4 and 1024');
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validatePassword(undefined)).toThrow('between 4 and 1024');
      // @ts-expect-error Testing runtime non-string validation
      expect(() => validatePassword(12345)).toThrow('between 4 and 1024');
    });
  });

  describe('generateSalt', () => {
    it('should generate a 32-character hex string by default (16 bytes)', () => {
      const salt = generateSalt();
      expect(salt).toMatch(/^[0-9a-f]{32}$/);
    });

    it('should generate custom length salts when specified', () => {
      const salt8 = generateSalt(8);
      expect(salt8).toMatch(/^[0-9a-f]{16}$/);

      const salt32 = generateSalt(32);
      expect(salt32).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should generate unique random salts across invocations', () => {
      const salts = new Set(Array.from({ length: 50 }, () => generateSalt()));
      expect(salts.size).toBe(50);
    });
  });

  describe('generateTokenSecret', () => {
    it('should generate secret with default prefix', () => {
      const secret = generateTokenSecret();
      expect(secret.startsWith('tetherdb-secret-')).toBe(true);
      expect(secret.length).toBeGreaterThan(20);
    });

    it('should generate secret with custom prefix', () => {
      const secret = generateTokenSecret('custom-app');
      expect(secret.startsWith('custom-app-')).toBe(true);
    });

    it('should generate unique secrets across invocations', () => {
      const s1 = generateTokenSecret();
      const s2 = generateTokenSecret();
      expect(s1).not.toBe(s2);
    });
  });

  describe('hashPassword & verifyPassword', () => {
    it('should generate a 64-character hex scrypt hash (32 bytes)', () => {
      const salt = generateSalt();
      const hash = hashPassword('correct-password', salt);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce identical hash for same password and salt', () => {
      const salt = generateSalt();
      const hash1 = hashPassword('repeatable-pwd', salt);
      const hash2 = hashPassword('repeatable-pwd', salt);
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different salts', () => {
      const salt1 = generateSalt();
      const salt2 = generateSalt();
      const hash1 = hashPassword('same-pwd', salt1);
      const hash2 = hashPassword('same-pwd', salt2);
      expect(hash1).not.toBe(hash2);
    });

    it('should verify correct password successfully', () => {
      const salt = generateSalt();
      const hash = hashPassword('valid-pass-123', salt);
      expect(verifyPassword('valid-pass-123', salt, hash)).toBe(true);
    });

    it('should reject incorrect passwords', () => {
      const salt = generateSalt();
      const hash = hashPassword('valid-pass-123', salt);
      expect(verifyPassword('wrong-pass-123', salt, hash)).toBe(false);
    });

    it('should reject empty or invalid password inputs', () => {
      const salt = generateSalt();
      const hash = hashPassword('valid-pass-123', salt);
      expect(verifyPassword('', salt, hash)).toBe(false);
      // @ts-expect-error Testing runtime non-string validation
      expect(verifyPassword(null, salt, hash)).toBe(false);
      // @ts-expect-error Testing runtime non-string validation
      expect(verifyPassword(undefined, salt, hash)).toBe(false);
    });

    it('should return false if stored hash length is invalid', () => {
      const salt = generateSalt();
      expect(verifyPassword('pwd', salt, 'short-hash')).toBe(false);
    });
  });

  describe('createUserAccount', () => {
    it('should create complete UserAccount record with valid UUID and timestamps', () => {
      const before = Date.now();
      const account = createUserAccount('developer', 'strongpassword');
      const after = Date.now();

      expect(account.username).toBe('developer');
      expect(account.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
      expect(account.salt).toHaveLength(32);
      expect(account.passwordHash).toHaveLength(64);
      expect(account.createdAt).toBeGreaterThanOrEqual(before);
      expect(account.createdAt).toBeLessThanOrEqual(after);
      expect(account.lastLoginAt).toBe(account.createdAt);

      expect(
        verifyPassword('strongpassword', account.salt, account.passwordHash),
      ).toBe(true);
    });

    it('should accept an explicit user ID if provided', () => {
      const customId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
      const account = createUserAccount(
        'custom_id_user',
        'password123',
        customId,
      );
      expect(account.id).toBe(customId);
    });

    it('should reject invalid usernames', () => {
      expect(() => createUserAccount('a', 'password123')).toThrow(
        'between 2 and 64',
      );
      expect(() => createUserAccount('../evil', 'password123')).toThrow(
        'Invalid username',
      );
      expect(() => createUserAccount('__proto__', 'password123')).toThrow(
        'reserved',
      );
    });

    it('should reject invalid passwords', () => {
      expect(() => createUserAccount('validuser', '123')).toThrow(
        'between 4 and 1024',
      );
    });
  });

  describe('generateSessionToken & verifySessionToken', () => {
    const secret = 'test-signing-secret-key-12345';
    const session = {
      userId: '22222222-3333-4444-5555-666666666666',
      username: 'tokenholder',
    };

    it('should generate a valid dot-separated token (base64url payload + signature)', () => {
      const token = generateSessionToken(session, secret);
      expect(typeof token).toBe('string');
      expect(token).toContain('.');
      const [payload, sig] = token.split('.');
      expect(payload).toBeDefined();
      expect(sig).toBeDefined();
    });

    it('should verify and decode valid session token', () => {
      const token = generateSessionToken(session, secret);
      const decoded = verifySessionToken(token, secret);
      expect(decoded).not.toBeNull();
      expect(decoded?.userId).toBe(session.userId);
      expect(decoded?.username).toBe(session.username);
    });

    it('should return null for token signed with a different secret', () => {
      const token = generateSessionToken(session, secret);
      expect(verifySessionToken(token, 'different-secret-key')).toBeNull();
    });

    it('should return null for tampered signature', () => {
      const token = generateSessionToken(session, secret);
      const [payload, sig] = token.split('.');
      const tampered = `${payload}.${sig.slice(0, -4)}xxxx`;
      expect(verifySessionToken(tampered, secret)).toBeNull();
    });

    it('should return null for tampered payload', () => {
      const token = generateSessionToken(session, secret);
      const [, sig] = token.split('.');
      const fakePayload = Buffer.from(
        JSON.stringify({
          userId: 'hacked',
          username: 'admin',
          iat: Date.now(),
        }),
      ).toString('base64url');
      expect(verifySessionToken(`${fakePayload}.${sig}`, secret)).toBeNull();
    });

    it('should return null for invalid or corrupted token formats', () => {
      expect(verifySessionToken('', secret)).toBeNull();
      expect(verifySessionToken('no-dot-token', secret)).toBeNull();
      expect(verifySessionToken('.signature-only', secret)).toBeNull();
      expect(verifySessionToken('payload-only.', secret)).toBeNull();
      expect(verifySessionToken('invalid.payload.format', secret)).toBeNull();
      // @ts-expect-error Testing runtime non-string validation
      expect(verifySessionToken(null, secret)).toBeNull();
      // @ts-expect-error Testing runtime non-string validation
      expect(verifySessionToken(undefined, secret)).toBeNull();
    });

    it('should return null if payload JSON does not contain string userId and username', () => {
      const invalidPayload = Buffer.from(
        JSON.stringify({ userId: 12345, username: null }),
      ).toString('base64url');
      const crypto = require('node:crypto');
      const sig = crypto
        .createHmac('sha256', secret)
        .update(invalidPayload)
        .digest('base64url');
      const token = `${invalidPayload}.${sig}`;

      expect(verifySessionToken(token, secret)).toBeNull();
    });
  });
});
