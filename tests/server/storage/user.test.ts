import { describe, expect, it } from 'vitest';
import { createSessionToken } from '../../../src/server/shared/crypto.js';
import { MemoryStorage } from '../../../src/server/storage/memory.js';

describe('User', () => {
  it('creates user and verifies credentials', async () => {
    const storage = new MemoryStorage();
    const user = await storage.createUser('alice', 'supersecret123');

    expect(user.userId).toBeDefined();
    expect(user.userName).toBe('alice');
    expect(user.createdAt).toBeGreaterThan(0);

    expect(await user.verifyPassword('supersecret123')).toBe(true);
    expect(await user.verifyPassword('wrongpassword')).toBe(false);
  });

  it('changes password and verifies new password', async () => {
    const storage = new MemoryStorage();
    const user = await storage.createUser('bob', 'oldpass123');

    await user.changePassword('newpass456');
    expect(await user.verifyPassword('oldpass123')).toBe(false);
    expect(await user.verifyPassword('newpass456')).toBe(true);
  });

  it('creates and verifies session tokens', async () => {
    const storage = new MemoryStorage();
    const alice = await storage.createUser('alice', 'pass123');
    const bob = await storage.createUser('bob', 'pass123');

    const token = await alice.createToken();
    expect(await alice.verifyToken(token)).toBe(true);
    expect(await bob.verifyToken(token)).toBe(false);
    expect(await alice.verifyToken('invalid-token')).toBe(false);

    const userByToken = await storage.getUserByToken(token);
    expect(userByToken?.userId).toBe(alice.userId);
  });

  it('deletes user through user instance', async () => {
    const storage = new MemoryStorage();
    const user = await storage.createUser('charlie', 'pass123');
    expect(await storage.getUser(user.userId)).toBeDefined();
    const deleted = await user.delete();
    expect(deleted).toBe(true);
    expect(await storage.getUser(user.userId)).toBeUndefined();
  });

  it('rejects tokens when password hash changes or does not match', async () => {
    const storage = new MemoryStorage();
    const user = await storage.createUser(
      'token_check_user',
      'initial_pass123',
    );
    const token = await user.createToken();
    expect(await user.verifyToken(token)).toBe(true);
    await user.changePassword('updated_pass456');
    expect(await user.verifyToken(token)).toBe(false);
  });

  it('rejects tokens generated without pwd claim for accounts with a password', async () => {
    const storage = new MemoryStorage();
    const user = await storage.createUser('alice_pwd', 'Password123!');
    const tokenWithoutPwd = createSessionToken(
      user.userId,
      user.userName,
      storage.secret,
      3600,
    );
    expect(await user.verifyToken(tokenWithoutPwd)).toBe(false);
  });
});
