import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStorage } from '../../../../src/server/storage/file/index.js';
import { OperationType } from '../../../../src/shared/types.js';

describe('src/server/storage/file/ (FileStorage)', () => {
  let tmpDir: string;
  let storage: FileStorage;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-filestorage-${Math.random().toString(36).substring(2, 10)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    storage = new FileStorage({ baseDir: tmpDir });
  });

  afterEach(async () => {
    await storage.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should persist user credentials and allow verification after reload', async () => {
    const user = await storage.createUser('bob', 'secret123');
    expect(user.username).toBe('bob');

    // Create a second storage pointing to the same directory
    const storage2 = new FileStorage({ baseDir: tmpDir });
    const loadedUser = await storage2.getUserByUsername('bob');
    expect(loadedUser).toBeDefined();
    expect(await loadedUser?.verifyPassword('secret123')).toBe(true);
    expect(await loadedUser?.verifyPassword('wrong')).toBe(false);
  });

  it('should delete user accounts and their filesystem data', async () => {
    const user = await storage.createUser('charlie', 'password');
    const app = await storage.createApp('app1');
    const table = await app.createTable('data');
    await table.applyChanges(user, [
      {
        table: 'data',
        id: '1',
        op: OperationType.Put,
        data: 'content',
        timestamp: 100,
        clientId: 'c1',
      },
    ]);

    expect(await table.getRecord(user, '1')).toBeDefined();
    await user.delete();

    expect(await storage.getUser(user.id)).toBeUndefined();
    expect(await storage.getUserByUsername('charlie')).toBeUndefined();
  });
});
