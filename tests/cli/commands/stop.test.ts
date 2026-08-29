import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleStopCommand } from '../../../src/cli/commands/stop.js';
import {
  SqliteStorage,
  TetherServer,
  TetherServerError,
  TetherServerErrorCode,
} from '../../../src/server/index.js';
import { testLogger } from '../../logger.js';

describe('handleStopCommand', () => {
  let tmpDir: string;
  let server: TetherServer | null = null;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-stop-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
    );
    await fs.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('should throw NotFound when no server lock exists', async () => {
    await expect(handleStopCommand(tmpDir)).rejects.toThrow(TetherServerError);

    try {
      await handleStopCommand(tmpDir);
    } catch (err) {
      expect((err as TetherServerError).code).toBe(
        TetherServerErrorCode.NotFound,
      );
    }
  });

  it('should stop a running server via AdminClient when lockfile is present', async () => {
    const storage = new SqliteStorage({ baseDir: tmpDir });
    server = new TetherServer({ storage });
    await server.listen(0, '127.0.0.1');

    testLogger.clear();
    await handleStopCommand(tmpDir);

    expect(testLogger.hasMessage('Server stopping')).toBe(true);
    server = null;
  });

  it('should stop a running server using an explicit admin token', async () => {
    server = new TetherServer({ adminSecret: 'custom-secret' });
    await server.listen(0, '127.0.0.1');
    const token = server.getAdminToken('127.0.0.1');

    testLogger.clear();
    await handleStopCommand(tmpDir, token);

    expect(testLogger.hasMessage('Server stopping')).toBe(true);
    server = null;
  });
});
