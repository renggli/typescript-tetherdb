import { describe, expect, it } from 'vitest';
import { MemoryAuthAdapter } from '../../../src/server/auth/memory.js';

describe('src/server/auth/memory.ts (MemoryAuthAdapter)', () => {
  it('should initialize with default auto-generated secret if none provided', async () => {
    const auth = new MemoryAuthAdapter();
    const reg = await auth.register('alice', 'secretpassword');
    const session = await auth.verifyToken(reg.token);
    expect(session?.username).toBe('alice');
  });

  it('should initialize with custom tokenSecret option', async () => {
    const auth1 = new MemoryAuthAdapter({ tokenSecret: 'shared-secret-key-1' });
    const auth2 = new MemoryAuthAdapter({ tokenSecret: 'shared-secret-key-1' });
    const auth3 = new MemoryAuthAdapter({
      tokenSecret: 'different-secret-key',
    });

    const reg = await auth1.register('alice', 'secretpassword');
    expect(await auth1.verifyToken(reg.token)).not.toBeNull();
    expect(await auth2.verifyToken(reg.token)).not.toBeNull();
    expect(await auth3.verifyToken(reg.token)).toBeNull();
  });

  it('should register a new user and return AuthToken with UUID and username', async () => {
    const auth = new MemoryAuthAdapter();
    const result = await auth.register('bob', 'superpassword');

    expect(result.username).toBe('bob');
    expect(result.userId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.token).toBeDefined();

    const user = await auth.getUserById(result.userId);
    expect(user).toBeDefined();
    expect(user?.username).toBe('bob');
  });

  it('should reject duplicate usernames regardless of casing', async () => {
    const auth = new MemoryAuthAdapter();
    await auth.register('charlie', 'password123');

    await expect(auth.register('charlie', 'password456')).rejects.toThrow(
      'already exists',
    );
    await expect(auth.register('CHARLIE', 'password456')).rejects.toThrow(
      'already exists',
    );
    await expect(auth.register('  Charlie  ', 'password456')).rejects.toThrow(
      'already exists',
    );
  });

  it('should reject invalid or reserved usernames', async () => {
    const auth = new MemoryAuthAdapter();
    await expect(auth.register('../evil', 'password123')).rejects.toThrow(
      'Invalid username',
    );
    await expect(auth.register('__proto__', 'password123')).rejects.toThrow(
      'reserved',
    );
    await expect(auth.register('x', 'password123')).rejects.toThrow(
      'between 2 and 64',
    );
  });

  it('should reject invalid passwords during registration', async () => {
    const auth = new MemoryAuthAdapter();
    await expect(auth.register('dan', '123')).rejects.toThrow(
      'between 4 and 1024',
    );
    await expect(auth.register('dan', '')).rejects.toThrow(
      'between 4 and 1024',
    );
  });

  it('should login an existing user with valid credentials and update lastLoginAt', async () => {
    const auth = new MemoryAuthAdapter();
    const reg = await auth.register('eve', 'correctpwd123');
    const initialLoginAt =
      (await auth.getUserById(reg.userId))?.lastLoginAt ?? 0;

    await new Promise((r) => setTimeout(r, 15));
    const loginResult = await auth.login('eve', 'correctpwd123');

    expect(loginResult.userId).toBe(reg.userId);
    expect(loginResult.username).toBe('eve');
    expect(loginResult.token).toBeDefined();

    const updatedUser = await auth.getUserById(reg.userId);
    expect((updatedUser?.lastLoginAt ?? 0) > initialLoginAt).toBe(true);
  });

  it('should reject login for wrong password or nonexistent user without changing lastLoginAt', async () => {
    const auth = new MemoryAuthAdapter();
    const reg = await auth.register('frank', 'mypassword');
    const initialLoginAt =
      (await auth.getUserById(reg.userId))?.lastLoginAt ?? 0;

    await expect(auth.login('frank', 'wrongpassword')).rejects.toThrow(
      'Invalid username or password',
    );
    await expect(auth.login('nonexistent', 'mypassword')).rejects.toThrow(
      'Invalid username or password',
    );
    await expect(auth.login('frank', '')).rejects.toThrow(
      'Invalid username or password',
    );

    expect((await auth.getUserById(reg.userId))?.lastLoginAt).toBe(
      initialLoginAt,
    );
  });

  it('should resolve users by ID and case-insensitive username', async () => {
    const auth = new MemoryAuthAdapter();
    const reg = await auth.register('Grace', 'password123');

    const byId = await auth.getUserById(reg.userId);
    expect(byId?.username).toBe('grace');

    const byNameLower = await auth.getUserByUsername('grace');
    expect(byNameLower?.id).toBe(reg.userId);

    const byNameUpper = await auth.getUserByUsername('GRACE');
    expect(byNameUpper?.id).toBe(reg.userId);

    expect(await auth.getUserById('non-existent-id')).toBeUndefined();
    expect(await auth.getUserByUsername('unknown')).toBeUndefined();
  });

  it('should support manual generateToken helper', async () => {
    const auth = new MemoryAuthAdapter();
    const token = auth.generateToken('user-123', 'custom_user');
    const session = await auth.verifyToken(token);
    expect(session?.userId).toBe('user-123');
    expect(session?.username).toBe('custom_user');
  });

  it('should clear all stored user accounts on clear()', async () => {
    const auth = new MemoryAuthAdapter();
    const reg = await auth.register('heidi', 'password123');

    expect(await auth.getUserById(reg.userId)).toBeDefined();
    auth.clear();

    expect(await auth.getUserById(reg.userId)).toBeUndefined();
    expect(await auth.getUserByUsername('heidi')).toBeUndefined();
  });
});
