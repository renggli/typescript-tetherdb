import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/index.js';

describe('runCli', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(
      os.tmpdir(),
      `tetherdb-cli-main-test-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
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

  it('should show help message with help, --help, -h, -?, and /? flags', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    for (const flag of ['--help', '-h', 'help', '-?', '/?', '-help']) {
      logSpy.mockClear();
      await runCli([flag]);
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('TetherDB CLI'),
      );
    }

    logSpy.mockRestore();
  });

  it('should run serve command and handle SIGINT shutdown signal', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as unknown as (
        code?: string | number | null | undefined,
      ) => never);

    await runCli([
      'serve',
      '--port=0',
      '--host=127.0.0.1',
      `--sqlite=${tmpDir}`,
    ]);

    // Emit shutdown signal
    process.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 50));

    expect(logSpy).toHaveBeenCalledWith('Stopping TetherDB server...');
    expect(exitSpy).toHaveBeenCalledWith(0);

    logSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('should handle errors and exit with code 1 for invalid commands or flags', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as unknown as (
        code?: string | number | null | undefined,
      ) => never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Unknown command
    await runCli(['unknown_command']);
    expect(errorSpy).toHaveBeenCalledWith(
      'Command failed:',
      'Unknown command: "unknown_command"',
    );
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Invalid option format
    await runCli(['--port', '8080']);
    expect(errorSpy).toHaveBeenCalledWith(
      'Command failed:',
      expect.stringContaining('Unknown or invalid option: "--port"'),
    );

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('should route subcommands correctly (apps, tables, users)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // Apps command
    await runCli(['apps', 'add', 'my-app', `--sqlite=${tmpDir}`]);
    expect(logSpy).toHaveBeenCalledWith('Created application: my-app');

    // Tables command
    await runCli(['tables', 'add', 'my-app', 'items', `--sqlite=${tmpDir}`]);
    expect(logSpy).toHaveBeenCalledWith(
      'Added table "items" to application "my-app"',
    );

    // Users command
    await runCli(['users', 'add', 'alice', 'secret', `--sqlite=${tmpDir}`]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Created user: ['),
    );

    logSpy.mockRestore();
  });
});
