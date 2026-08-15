import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteAuthAdapter } from '../../../src/server/auth/sqlite.js';

describe('src/server/auth/sqlite.ts (SqliteAuthAdapter)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-auth-sqlite-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('should register a new user, hash password, and issue valid token in baseDir/auth.sqlite', async () => {
    const auth = new SqliteAuthAdapter({ baseDir: tmpDir });

    const result = await auth.register('alice', 'securepassword123');
    expect(result.userId).toBeDefined();
    expect(result.username).toBe('alice');
    expect(result.token).toBeDefined();

    const session = await auth.verifyToken(result.token);
    expect(session).not.toBeNull();
    expect(session?.userId).toBe(result.userId);
    expect(session?.username).toBe('alice');

    const user = await auth.getUserById(result.userId);
    expect(user).toBeDefined();
    expect(user?.username).toBe('alice');
    expect(user?.passwordHash).not.toBe('securepassword123');
    expect(user?.salt).toBeDefined();

    // Verify auth.sqlite file exists in tmpDir
    const exists = await fs
      .access(path.join(tmpDir, 'auth.sqlite'))
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(true);

    await auth.close();
  });

  it('should persist users and verify credentials across database reconnects', async () => {
    const auth1 = new SqliteAuthAdapter({ baseDir: tmpDir });
    const reg = await auth1.register('bob', 'bobssecretpassword');
    await auth1.close();

    // Reconnect to same directory
    const auth2 = new SqliteAuthAdapter({ baseDir: tmpDir });

    // Login with valid credentials
    const loginRes = await auth2.login('bob', 'bobssecretpassword');
    expect(loginRes.userId).toBe(reg.userId);
    expect(loginRes.username).toBe('bob');

    // Verify token issued in session 1 still validates in session 2 (persisted token secret)
    const session = await auth2.verifyToken(reg.token);
    expect(session?.userId).toBe(reg.userId);

    // Reject wrong password
    await expect(auth2.login('bob', 'wrongpwd')).rejects.toThrow(
      'Invalid username or password',
    );

    // Reject non-existent user
    await expect(auth2.login('nonexistent', 'pwd')).rejects.toThrow(
      'Invalid username or password',
    );

    await auth2.close();
  });

  it('should reject duplicate username registrations regardless of casing or whitespace', async () => {
    const auth = new SqliteAuthAdapter({ baseDir: tmpDir });
    await auth.register('Charlie', 'password123');

    await expect(auth.register('charlie', 'password456')).rejects.toThrow(
      'already exists',
    );
    await expect(auth.register('  CHARLIE  ', 'password456')).rejects.toThrow(
      'already exists',
    );

    await auth.close();
  });

  it('should validate and normalize usernames and passwords on registration', async () => {
    const auth = new SqliteAuthAdapter({ baseDir: tmpDir });

    await expect(auth.register('x', 'password123')).rejects.toThrow(
      'between 2 and 64',
    );
    await expect(auth.register('../evil', 'password123')).rejects.toThrow(
      'Invalid username',
    );
    await expect(auth.register('__proto__', 'password123')).rejects.toThrow(
      'reserved',
    );
    await expect(auth.register('david', '123')).rejects.toThrow(
      'between 4 and 1024',
    );

    const reg = await auth.register('  David  ', 'password123');
    expect(reg.username).toBe('david');

    const byId = await auth.getUserById(reg.userId);
    expect(byId?.username).toBe('david');

    const byName = await auth.getUserByUsername('DAVID');
    expect(byName?.id).toBe(reg.userId);

    await auth.close();
  });

  it('should update lastLoginAt upon successful login', async () => {
    const auth = new SqliteAuthAdapter({ baseDir: tmpDir });
    const reg = await auth.register('eve', 'password123');

    const initialUser = await auth.getUserById(reg.userId);
    const initialLoginAt = initialUser?.lastLoginAt ?? 0;

    await new Promise((r) => setTimeout(r, 15));
    await auth.login('eve', 'password123');

    const updatedUser = await auth.getUserById(reg.userId);
    expect((updatedUser?.lastLoginAt ?? 0) > initialLoginAt).toBe(true);

    await auth.close();
  });

  it('should support in-memory SQLite and clear method', async () => {
    const auth = new SqliteAuthAdapter({ inMemory: true });
    const reg = await auth.register('frank', 'password123');

    expect(await auth.getUserById(reg.userId)).toBeDefined();

    auth.clear();
    expect(await auth.getUserById(reg.userId)).toBeUndefined();
    expect(await auth.getUserByUsername('frank')).toBeUndefined();

    await auth.close();
  });
});
