import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createSessionToken,
  getOrCreateKeyfileSecret,
  hashPassword,
  verifyDummyPasswordHash,
  verifyPasswordHash,
  verifySessionToken,
} from '../../src/server/crypto.js';

describe('Crypto', () => {
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
      userName: 'alice',
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
    expect(
      verifySessionToken('invalid_base64%.invalid_sig%', secret),
    ).toBeNull();
  });

  it('should handle usernames and userIds with colons and special characters safely', () => {
    const secret = 'super-secret-key-123';
    const userId = 'usr:org:12345';
    const userName = 'alice:admin:team';
    const token = createSessionToken(userId, userName, secret, 3600);

    const payload = verifySessionToken(token, secret);
    expect(payload).toEqual({
      userId: 'usr:org:12345',
      userName: 'alice:admin:team',
      expiresAt: expect.any(Number),
    });
  });

  it('should generate and persist keyfile secrets', async () => {
    const tmpDir = path.join(
      os.tmpdir(),
      `tether_crypto_test_${Math.random().toString(36).substring(2, 9)}`,
    );

    try {
      const secret1 = getOrCreateKeyfileSecret(tmpDir);
      expect(typeof secret1).toBe('string');
      expect(secret1.length).toBe(64);

      // Subsequent call in the same directory should read the same secret
      const secret2 = getOrCreateKeyfileSecret(tmpDir);
      expect(secret2).toBe(secret1);

      // Verify file exists on disk
      const content = await fs.readFile(path.join(tmpDir, '.secret'), 'utf-8');
      expect(content.trim()).toBe(secret1);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('should safely verify dummy password hashes in constant time', async () => {
    const result = await verifyDummyPasswordHash('anyPassword123');
    expect(result).toBe(false);
  });

  it('should reject tokens with valid signature but invalid JSON payload structure', () => {
    const secret = 'super-secret-key-123';

    const signPayload = (payloadStr: string) => {
      const b64 = Buffer.from(payloadStr, 'utf-8').toString('base64url');
      const sig = crypto
        .createHmac('sha256', secret)
        .update(b64)
        .digest('base64url');
      return `${b64}.${sig}`;
    };

    // Invalid JSON
    expect(verifySessionToken(signPayload('not-json'), secret)).toBeNull();

    // Not an object (e.g. primitive number)
    expect(verifySessionToken(signPayload('12345'), secret)).toBeNull();

    // Missing userId
    expect(
      verifySessionToken(
        signPayload(
          JSON.stringify({ userName: 'alice', expiresAt: Date.now() + 10000 }),
        ),
        secret,
      ),
    ).toBeNull();

    // Invalid expiresAt
    expect(
      verifySessionToken(
        signPayload(
          JSON.stringify({
            userId: 'u1',
            userName: 'alice',
            expiresAt: 'not-a-number',
          }),
        ),
        secret,
      ),
    ).toBeNull();
  });
});
