import { describe, expect, it } from 'vitest';
import { UserResolver } from '../../../src/server/security/resolver.js';
import { MemoryStorage } from '../../../src/server/storage/memory.js';

describe('UserResolver', () => {
  it('resolves undefined when no userId is given', async () => {
    const storage = new MemoryStorage();
    const resolver = new UserResolver(storage);

    const resolved = await resolver.resolveUserName(undefined);
    expect(resolved).toBeUndefined();
  });

  it('resolves directly from matching fallbackUser without storage lookup', async () => {
    const storage = new MemoryStorage();
    const user = await storage.createUser('alice', 'password123');
    const resolver = new UserResolver(storage);

    const resolved = await resolver.resolveUserName(user.userId, user);
    expect(resolved).toBe('alice');
  });

  it('resolves from storage when not cached or not matching fallbackUser', async () => {
    const storage = new MemoryStorage();
    const user = await storage.createUser('bob', 'password123');
    const resolver = new UserResolver(storage);

    const resolved = await resolver.resolveUserName(user.userId);
    expect(resolved).toBe('bob');
  });

  it('uses primed cache values', async () => {
    const storage = new MemoryStorage();
    const resolver = new UserResolver(storage);
    resolver.prime('custom-id', 'charlie');

    const resolved = await resolver.resolveUserName('custom-id');
    expect(resolved).toBe('charlie');
  });

  it('returns undefined for non-existent userId', async () => {
    const storage = new MemoryStorage();
    const resolver = new UserResolver(storage);

    const resolved = await resolver.resolveUserName('non-existent-user-id');
    expect(resolved).toBeUndefined();
  });
});
