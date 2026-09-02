import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStorage } from '../../../src/server/storage/file.js';

describe('FileStorage Lock Cleanup', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'tether-file-lock-clean-'),
    );
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it('cleans up chained lock references from locks map in withLock once resolved', async () => {
    const storage = new FileStorage({ baseDir: tempDir });
    try {
      await storage.createTable('test_table');
      // @ts-expect-error accessing private locks map for verification
      const locksMap = storage.locks as Map<string, unknown>;
      expect(locksMap.has('__tables__')).toBe(false);
    } finally {
      await storage.close();
    }
  });
});
