import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../../../src/cli/cli.js';
import { handleVersionCommand } from '../../../src/cli/commands/version.js';
import { startServer } from '../../../src/server/server.js';
import { MemoryStorage } from '../../../src/server/storage/memory.js';
import { SqliteStorage } from '../../../src/server/storage/sqlite.js';
import { TETHER_VERSION } from '../../../src/shared/version.js';
import { testLogger } from '../../logger.js';

describe('handleVersionCommand', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-cli-version-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
    testLogger.clear();
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should print local version and unreachable remote when no remote server is running', async () => {
    const res = await handleVersionCommand(tmpDir);

    expect(res.local).toBe(TETHER_VERSION);
    expect(res.remote).toBeUndefined();
    if (res.localHash) {
      expect(typeof res.localHash).toBe('string');
    }
    expect(testLogger.hasMessage(`tetherdb ${TETHER_VERSION}`)).toBe(true);
    expect(testLogger.hasMessage('(remote: unreachable)')).toBe(true);
    expect(testLogger.hasMessage(/warning/i, 'warn')).toBe(true);
  });

  it('should print local and remote version when remote server is running', async () => {
    const storage = new SqliteStorage({ baseDir: tmpDir });
    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      storage,
      baseDir: tmpDir,
    });

    try {
      testLogger.clear();
      const res = await handleVersionCommand(tmpDir);

      expect(res.local).toBe(TETHER_VERSION);
      expect(res.remote).toBe(TETHER_VERSION);
      if (res.localHash) {
        expect(res.remoteHash).toBe(res.localHash);
      }
      expect(testLogger.hasMessage(`tetherdb ${TETHER_VERSION}`)).toBe(true);
      expect(testLogger.hasMessage(`remote ${TETHER_VERSION}`)).toBe(true);
      expect(testLogger.hasMessage(/warning/i, 'warn')).toBe(false);
    } finally {
      await server.close();
      await storage.close();
    }
  });

  it('should print local and remote version when token is provided', async () => {
    const storage = new MemoryStorage();
    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      storage,
    });

    try {
      testLogger.clear();
      const token = server.adminToken;
      const res = await handleVersionCommand(tmpDir, undefined, token);

      expect(res.local).toBe(TETHER_VERSION);
      expect(res.remote).toBe(TETHER_VERSION);
      if (res.localHash) {
        expect(res.remoteHash).toBe(res.localHash);
      }
      expect(testLogger.hasMessage(`tetherdb ${TETHER_VERSION}`)).toBe(true);
      expect(testLogger.hasMessage(`remote ${TETHER_VERSION}`)).toBe(true);
      expect(testLogger.hasMessage(/warning/i, 'warn')).toBe(false);
    } finally {
      await server.close();
      await storage.close();
    }
  });

  it('should execute through runCli with version command', async () => {
    testLogger.clear();
    await runCli(['version']);
    expect(testLogger.hasMessage(`tetherdb ${TETHER_VERSION}`)).toBe(true);
    expect(testLogger.hasMessage('(remote: unreachable)')).toBe(true);
  });
});
