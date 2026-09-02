import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileStorage } from '../../../src/server/storage/file.js';
import { OperationType, Permission } from '../../../src/shared/types.js';

describe('FileStorage Corrupt Changelog Resilience', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'tether-file-corrupt-'),
    );
  });

  afterEach(async () => {
    await fsPromises.rm(tempDir, { recursive: true, force: true });
  });

  it('recovers from corrupt JSONL lines without dropping subsequent valid changes', async () => {
    const storage = new FileStorage({ baseDir: tempDir });
    try {
      const table = await storage.createTable('shared_notes', {
        permissions: {
          read: Permission.Everybody,
          create: Permission.Everybody,
          update: Permission.Everybody,
          delete: Permission.Everybody,
        },
      });

      await storage.applyChanges(undefined, [
        {
          table: table.name,
          id: 'n1',
          op: OperationType.Put,
          data: { text: 'one' },
          timestamp: 100,
        },
        {
          table: table.name,
          id: 'n2',
          op: OperationType.Put,
          data: { text: 'two' },
          timestamp: 200,
        },
      ]);

      const syncFile = path.join(tempDir, 'shared', 'sync.jsonl');
      const content = await fsPromises.readFile(syncFile, 'utf-8');
      const lines = content.split('\n').filter(Boolean);

      // Insert a corrupt JSONL line in the middle
      const corruptContent = `${lines[0]}\n{corrupted-json-line\n${lines[1]}\n`;
      await fsPromises.writeFile(syncFile, corruptContent, 'utf-8');

      const { rawChanges } = await storage.getRawChangesSince(0);
      expect(rawChanges.map((c) => c.id)).toEqual(['n1', 'n2']);
    } finally {
      await storage.close();
    }
  });
});
