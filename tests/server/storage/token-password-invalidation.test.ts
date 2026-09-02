import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSessionToken } from '../../../src/server/shared/crypto.js';
import { MemoryStorage } from '../../../src/server/storage/memory.js';

describe('Token Password Invalidation', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  afterEach(async () => {
    await storage.close();
  });

  it('rejects tokens without pwd claim or with outdated hash when user has passwordHash', async () => {
    const user = await storage.createUser('alice', 'Password123!');
    const passwordHash = await storage.getUserPasswordHash(user.userId);
    expect(passwordHash).toBeTypeOf('string');

    // Token generated without pwd claim
    const tokenWithoutPwd = createSessionToken(
      user.userId,
      user.userName,
      storage.secret,
      3600,
    );

    // Token generated with correct pwd claim
    const validToken = createSessionToken(
      user.userId,
      user.userName,
      storage.secret,
      3600,
      passwordHash ?? '',
    );

    // Token without pwd claim must be rejected because the user has a passwordHash
    expect(await storage.getUserByToken(tokenWithoutPwd)).toBeUndefined();
    expect(await user.verifyToken(tokenWithoutPwd)).toBe(false);

    // Valid token with correct pwd claim is accepted
    expect(await storage.getUserByToken(validToken)).toBeDefined();
    expect(await user.verifyToken(validToken)).toBe(true);

    // After password change, old valid token is revoked
    await user.changePassword('NewPassword456!');
    expect(await storage.getUserByToken(validToken)).toBeUndefined();
    expect(await user.verifyToken(validToken)).toBe(false);
  });
});
