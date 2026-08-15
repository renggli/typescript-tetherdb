import { describe, expect, it } from 'vitest';
import { AuthManager } from '../src/server/auth.js';

describe('AuthManager', () => {
  it('should register a new user and return token', async () => {
    const auth = new AuthManager();
    const result = await auth.register('alice', 'supersecret');

    expect(result.user.username).toBe('alice');
    expect(result.user.id).toMatch(/^usr_/);
    expect(result.token).toBeDefined();

    // Verify token
    const session = auth.verifyToken(result.token);
    expect(session?.userId).toBe(result.user.id);
    expect(session?.username).toBe('alice');
  });

  it('should reject duplicate usernames', async () => {
    const auth = new AuthManager();
    await auth.register('bob', 'password123');

    await expect(auth.register('bob', 'password456')).rejects.toThrow(
      'already exists',
    );
    await expect(auth.register('BOB', 'password456')).rejects.toThrow(
      'already exists',
    );
  });

  it('should login registered user with correct password', async () => {
    const auth = new AuthManager();
    const registered = await auth.register('charlie', 'mypassword');

    const loginResult = await auth.login('charlie', 'mypassword');
    expect(loginResult.user.id).toBe(registered.user.id);

    const session = auth.verifyToken(loginResult.token);
    expect(session?.userId).toBe(registered.user.id);
  });

  it('should reject invalid login credentials', async () => {
    const auth = new AuthManager();
    await auth.register('dan', 'correctpwd');

    await expect(auth.login('dan', 'wrongpwd')).rejects.toThrow('Invalid');
    await expect(auth.login('nonexistent', 'pwd')).rejects.toThrow('Invalid');
  });

  it('should reject tampered tokens', () => {
    const auth = new AuthManager();
    const token = auth.generateToken('usr_123', 'alice');
    const tampered = `${token.slice(0, -4)}abcd`;

    expect(auth.verifyToken(tampered)).toBeNull();
  });
});
