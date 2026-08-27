import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BackendType, createBackend } from '../../src/cli/backend.js';
import {
  FileStorage,
  MemoryStorage,
  SqliteStorage,
  TetherServerError,
  TetherServerErrorCode,
} from '../../src/server/index.js';

describe('createBackend', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-cli-backend-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
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

  it('should create matching in-memory storage by default', () => {
    const storage = createBackend();
    expect(storage).toBeInstanceOf(MemoryStorage);

    const explicitMem = createBackend('memory');
    expect(explicitMem).toBeInstanceOf(MemoryStorage);
  });

  it('should create matching SQLite storage with resolved baseDir', () => {
    const storage = createBackend('sqlite', tmpDir);
    expect(storage).toBeInstanceOf(SqliteStorage);
  });

  it('should create matching file storage with resolved baseDir', () => {
    const storage = createBackend('file', tmpDir);
    expect(storage).toBeInstanceOf(FileStorage);
  });

  it('should pass custom options through createBackend', () => {
    const storage = createBackend('memory', '.data', {
      maxRecords: 500,
    });
    expect(storage).toBeInstanceOf(MemoryStorage);
  });

  it('should throw an error for unsupported backend types', () => {
    expect(() =>
      createBackend('unknown_backend' as unknown as BackendType),
    ).toThrow(TetherServerError);
    try {
      createBackend('unknown_backend' as unknown as BackendType);
    } catch (err) {
      expect((err as TetherServerError).code).toBe(
        TetherServerErrorCode.ConfigurationError,
      );
    }
  });
});
