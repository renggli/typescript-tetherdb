import { describe, expect, it } from 'vitest';
import { AuthManager } from '../src/server/auth.js';

describe('AuthManager', () => {
  it('should register a new user with UUID (no usr_ prefix) and return token', async () => {
    const auth = new AuthManager();
    const result = await auth.register('alice', 'supersecret');

    expect(result.user.username).toBe('alice');
    // Standard RFC4122 UUID regex (no usr_ prefix)
    expect(result.user.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.user.id.startsWith('usr_')).toBe(false);
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

  it('should reject unsafe or malicious usernames', async () => {
    const auth = new AuthManager();
    await expect(auth.register('../evil', 'password123')).rejects.toThrow(
      'Invalid username',
    );
    await expect(auth.register('evil/user', 'password123')).rejects.toThrow(
      'Invalid username',
    );
    await expect(auth.register('__proto__', 'password123')).rejects.toThrow(
      'reserved',
    );
    await expect(auth.register('a', 'password123')).rejects.toThrow(
      'Invalid username',
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
    await expect(auth.login('', '')).rejects.toThrow('Invalid');
  });

  it('should reject tampered or corrupted tokens', () => {
    const auth1 = new AuthManager({ tokenSecret: 'secret-key-1' });
    const auth2 = new AuthManager({ tokenSecret: 'secret-key-2' });

    const token = auth1.generateToken(
      '12345678-1234-1234-1234-123456789abc',
      'alice',
    );

    // Corrupted signature
    const tampered = `${token.slice(0, -4)}abcd`;
    expect(auth1.verifyToken(tampered)).toBeNull();

    // Invalid format tokens
    expect(auth1.verifyToken('')).toBeNull();
    expect(auth1.verifyToken('invalid-token')).toBeNull();
    expect(auth1.verifyToken('invalid.payload.format')).toBeNull();
    expect(auth1.verifyToken('notbase64.signature')).toBeNull();

    // Token signed with different secret key
    expect(auth2.verifyToken(token)).toBeNull();
  });
});
