import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileAuthAdapter } from '../../../src/server/auth/file.js';

describe('src/server/auth/file.ts (FileAuthAdapter)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = path.join(
      os.tmpdir(),
      `tetherdb-fileauth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('should initialize with baseDir defaults (users.json and secret.key)', async () => {
    const adapter = new FileAuthAdapter({ baseDir: tempDir });
    await adapter.init();

    const reg = await adapter.register('alice', 'password123');
    expect(reg.username).toBe('alice');

    const usersFile = path.join(tempDir, 'users.json');
    const secretFile = path.join(tempDir, 'secret.key');

    expect(await fs.stat(usersFile)).toBeDefined();
    expect(await fs.stat(secretFile)).toBeDefined();

    const rawUsers = JSON.parse(await fs.readFile(usersFile, 'utf-8'));
    expect(rawUsers).toHaveLength(1);
    expect(rawUsers[0].username).toBe('alice');
  });

  it('should initialize with custom explicit file paths and create missing parent directories', async () => {
    const nestedDir = path.join(tempDir, 'nested', 'config');
    const customUsersPath = path.join(nestedDir, 'custom_users.json');
    const customSecretPath = path.join(nestedDir, 'custom_secret.key');

    const adapter = new FileAuthAdapter({
      usersFilePath: customUsersPath,
      secretFilePath: customSecretPath,
    });
    await adapter.init();

    await adapter.register('bob', 'secretpass');

    expect(await fs.stat(customUsersPath)).toBeDefined();
    expect(await fs.stat(customSecretPath)).toBeDefined();
  });

  it('should persist user accounts across adapter instances', async () => {
    const adapter1 = new FileAuthAdapter({ baseDir: tempDir });
    await adapter1.init();

    const reg = await adapter1.register('charlie', 'mypassword123');

    // Create second instance reading from same disk directory
    const adapter2 = new FileAuthAdapter({ baseDir: tempDir });
    await adapter2.init();

    const user = await adapter2.getUserByUsername('charlie');
    expect(user).toBeDefined();
    expect(user?.id).toBe(reg.userId);

    // Can log in with second adapter
    const loginRes = await adapter2.login('charlie', 'mypassword123');
    expect(loginRes.userId).toBe(reg.userId);

    // Token from adapter 1 verifies with adapter 2 (shared secret.key)
    const session = await adapter2.verifyToken(reg.token);
    expect(session?.userId).toBe(reg.userId);
    expect(session?.username).toBe('charlie');
  });

  it('should persist updated lastLoginAt on successful login', async () => {
    const adapter1 = new FileAuthAdapter({ baseDir: tempDir });
    const reg = await adapter1.register('dan', 'password123');
    const initialLoginAt =
      (await adapter1.getUserById(reg.userId))?.lastLoginAt ?? 0;

    await new Promise((r) => setTimeout(r, 15));
    await adapter1.login('dan', 'password123');

    // Verify on disk via fresh instance
    const adapter2 = new FileAuthAdapter({ baseDir: tempDir });
    await adapter2.init();
    const updated = await adapter2.getUserById(reg.userId);
    expect((updated?.lastLoginAt ?? 0) > initialLoginAt).toBe(true);
  });

  it('should lazy-load data on getUserById or getUserByUsername if init was omitted', async () => {
    const adapter1 = new FileAuthAdapter({ baseDir: tempDir });
    await adapter1.register('eve', 'password123');

    const adapter2 = new FileAuthAdapter({ baseDir: tempDir });
    // Intentionally omit adapter2.init() call
    const userById = await adapter2.getUserByUsername('eve');
    expect(userById?.username).toBe('eve');
  });

  it('should reject duplicate usernames, invalid usernames, and wrong passwords', async () => {
    const adapter = new FileAuthAdapter({ baseDir: tempDir });
    await adapter.register('frank', 'password123');

    await expect(adapter.register('frank', 'password456')).rejects.toThrow(
      'already exists',
    );
    await expect(adapter.register('../bad', 'password456')).rejects.toThrow(
      'Invalid username',
    );
    await expect(adapter.login('frank', 'wrongpwd')).rejects.toThrow(
      'Invalid username or password',
    );
  });

  it('should handle concurrent registrations safely with lock chaining', async () => {
    const adapter = new FileAuthAdapter({ baseDir: tempDir });
    await adapter.init();

    // Fire 5 concurrent registrations
    await Promise.all([
      adapter.register('user1', 'password123'),
      adapter.register('user2', 'password123'),
      adapter.register('user3', 'password123'),
      adapter.register('user4', 'password123'),
      adapter.register('user5', 'password123'),
    ]);

    const adapter2 = new FileAuthAdapter({ baseDir: tempDir });
    await adapter2.init();

    for (let i = 1; i <= 5; i++) {
      expect(await adapter2.getUserByUsername(`user${i}`)).toBeDefined();
    }
  });

  it('should work without usersFilePath (in-memory mode if path omitted)', async () => {
    const adapter = new FileAuthAdapter({});
    const reg = await adapter.register('inmemory_user', 'password123');
    expect(reg.username).toBe('inmemory_user');

    const session = await adapter.verifyToken(reg.token);
    expect(session?.username).toBe('inmemory_user');
  });
});
