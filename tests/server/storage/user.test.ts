import { describe, expect, it } from 'vitest';
import { TetherServerErrorCode } from '../../../src/server/errors.js';
import { createSessionToken } from '../../../src/server/shared/crypto.js';
import { MemoryStorage } from '../../../src/server/storage/memory.js';
import { User } from '../../../src/server/storage/user.js';

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

  it('provides well-defined User.Anonymous singleton', async () => {
    const anon1 = User.Anonymous;
    const anon2 = User.Anonymous;
    expect(anon1).toBe(anon2);
    expect(anon1.userId).toBe('');
    expect(anon1.userName).toBe('');
    expect(anon1.createdAt).toBe(0);
    expect(anon1.isAuthenticated).toBe(false);
    expect(anon1.isAdmin).toBe(false);
    expect(anon1.isAnonymous).toBe(true);

    expect(await anon1.verifyPassword('anything')).toBe(false);
    expect(await anon1.verifyToken('anything')).toBe(false);
    expect(await anon1.delete()).toBe(false);
    await expect(anon1.changePassword('newpass')).rejects.toMatchObject({
      code: TetherServerErrorCode.InvalidInput,
      message: 'Operation not supported for anonymous user',
    });
    await expect(anon1.createToken()).rejects.toMatchObject({
      code: TetherServerErrorCode.InvalidInput,
      message: 'Operation not supported for anonymous user',
    });
  });

  it('provides well-defined User.Admin singleton', async () => {
    const admin1 = User.Admin;
    const admin2 = User.Admin;
    expect(admin1).toBe(admin2);
    expect(admin1.userId).toBe('');
    expect(admin1.userName).toBe('');
    expect(admin1.createdAt).toBe(0);
    expect(admin1.isAuthenticated).toBe(true);
    expect(admin1.isAdmin).toBe(true);
    expect(admin1.isAnonymous).toBe(false);

    expect(await admin1.verifyPassword('anything')).toBe(false);
    expect(await admin1.verifyToken('anything')).toBe(false);
    expect(await admin1.delete()).toBe(false);
    await expect(admin1.changePassword('newpass')).rejects.toMatchObject({
      code: TetherServerErrorCode.InvalidInput,
      message: 'Operation not supported for admin user',
    });
    await expect(admin1.createToken()).rejects.toMatchObject({
      code: TetherServerErrorCode.InvalidInput,
      message: 'Operation not supported for admin user',
    });
  });

  it('guarantees storage creates only authenticated users with fixed non-admin roles', async () => {
    const storage = new MemoryStorage();
    const user = await storage.createUser('regular_user', 'Pass12345!');

    expect(user.isAuthenticated).toBe(true);
    expect(user.isAdmin).toBe(false);
    expect(user.isAnonymous).toBe(false);
    expect(user.userId).not.toBe('__admin__');
    expect(user.userId).not.toBe('');
    expect(user.userName).toBe('regular_user');

    // User lookup retains the same invariant
    const lookedUp = await storage.getUser(user.userId);
    expect(lookedUp).toBeDefined();
    expect(lookedUp?.isAuthenticated).toBe(true);
    expect(lookedUp?.isAdmin).toBe(false);
    expect(lookedUp?.isAnonymous).toBe(false);

    const lookedUpByName = await storage.getUserByUserName('regular_user');
    expect(lookedUpByName).toBeDefined();
    expect(lookedUpByName?.isAuthenticated).toBe(true);
    expect(lookedUpByName?.isAdmin).toBe(false);
    expect(lookedUpByName?.isAnonymous).toBe(false);

    const allUsers = await storage.getUsers();
    expect(allUsers).toHaveLength(1);
    expect(allUsers[0].isAuthenticated).toBe(true);
    expect(allUsers[0].isAdmin).toBe(false);
    expect(allUsers[0].isAnonymous).toBe(false);
  });

  it('throws NotFound when verifying password for deleted user', async () => {
    const storage = new MemoryStorage();
    const user = await storage.createUser('doomed', 'Pass12345!');
    await storage.deleteUser(user.userId);

    await expect(user.verifyPassword('Pass12345!')).rejects.toMatchObject({
      code: TetherServerErrorCode.NotFound,
      message: 'User not found',
    });
  });

  it('verifies createAuthenticatedUser creates an authentic user bound to storage', async () => {
    const storage = new MemoryStorage();
    await storage.createUser('manual', 'InitialPass123!');
    const raw = await storage.getUserByUserName('manual');
    expect(raw).toBeDefined();

    // Verify properties and role invariants
    expect(raw?.isAuthenticated).toBe(true);
    expect(raw?.isAdmin).toBe(false);
    expect(raw?.isAnonymous).toBe(false);

    // Password operations
    expect(await raw?.verifyPassword('InitialPass123!')).toBe(true);
    expect(await raw?.verifyPassword('Wrong')).toBe(false);

    // Change password
    await raw?.changePassword('NewPass98765!');
    expect(await raw?.verifyPassword('InitialPass123!')).toBe(false);
    expect(await raw?.verifyPassword('NewPass98765!')).toBe(true);

    // Tokens
    expect(raw).toBeDefined();
    if (raw) {
      const token = await raw.createToken(3600);
      expect(typeof token).toBe('string');
      expect(await raw.verifyToken(token)).toBe(true);
    }
  });

  it('rejects expired session tokens', async () => {
    const storage = new MemoryStorage();
    const user = await storage.createUser('expiring_user', 'Pass12345!');

    // Create token that expires in -10 seconds
    const expiredToken = await user.createToken(-10);
    expect(await user.verifyToken(expiredToken)).toBe(false);
  });

  it('guarantees registering users with special names like admin or guest never escalates privileges', async () => {
    const storage = new MemoryStorage();
    const adminNamedUser = await storage.createUser('admin', 'AdminPass123!');
    const guestNamedUser = await storage.createUser('guest', 'GuestPass123!');
    const anonNamedUser = await storage.createUser('anonymous', 'AnonPass123!');

    for (const u of [adminNamedUser, guestNamedUser, anonNamedUser]) {
      expect(u.isAuthenticated).toBe(true);
      expect(u.isAdmin).toBe(false);
      expect(u.isAnonymous).toBe(false);
      expect(u.userId).not.toBe('');
      expect(u.userId).not.toBe('__admin__');
      expect(await u.verifyPassword('wrong')).toBe(false);
    }
  });
});
