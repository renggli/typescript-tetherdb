import { describe, expect, it } from 'vitest';
import {
  createSessionToken,
  hashPassword,
  verifyPasswordHash,
  verifySessionToken,
} from '../../src/server/crypto.js';

describe('src/server/crypto.ts', () => {
  it('should hash and verify passwords using scrypt', async () => {
    const password = 'mySecretPassword123!';
    const hash = await hashPassword(password);
    expect(hash).toMatch(/^scrypt\$[a-f0-9]+\$[a-f0-9]+$/);

    const valid = await verifyPasswordHash(password, hash);
    expect(valid).toBe(true);

    const invalid = await verifyPasswordHash('wrongPassword', hash);
    expect(invalid).toBe(false);
  });

  it('should reject malformed hashes safely', async () => {
    expect(await verifyPasswordHash('pass', '')).toBe(false);
    expect(await verifyPasswordHash('pass', 'plain-text')).toBe(false);
    expect(await verifyPasswordHash('pass', 'bcrypt$1$2')).toBe(false);
  });

  it('should create and verify signed session tokens', () => {
    const secret = 'super-secret-key-123';
    const token = createSessionToken('user_1', 'alice', secret, 3600);
    expect(typeof token).toBe('string');
    expect(token.includes('.')).toBe(true);

    const payload = verifySessionToken(token, secret);
    expect(payload).toEqual({
      userId: 'user_1',
      username: 'alice',
      expiresAt: expect.any(Number),
    });
  });

  it('should reject invalid or expired tokens', () => {
    const secret = 'super-secret-key-123';
    const token = createSessionToken('user_1', 'alice', secret, -10); // expired
    expect(verifySessionToken(token, secret)).toBeNull();

    const validToken = createSessionToken('user_1', 'alice', secret, 3600);
    expect(verifySessionToken(validToken, 'wrong-secret')).toBeNull();
    expect(verifySessionToken('tampered.token', secret)).toBeNull();
    expect(verifySessionToken('', secret)).toBeNull();
  });
});
