import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { testLogger } from '../logger.js';

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
    for (const flag of ['--help', '-h', 'help', '-?', '/?', '-help']) {
      testLogger.clear();
      await runCli([flag]);
      expect(testLogger.hasMessage('TetherDB CLI')).toBe(true);
    }
  });

  it('should run serve command and handle SIGINT shutdown signal', async () => {
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

    expect(testLogger.hasMessage('Stopping TetherDB server...')).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });

  it('should handle errors and exit with code 1 for invalid commands or flags', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as unknown as (
        code?: string | number | null | undefined,
      ) => never);

    // Unknown command
    await runCli(['unknown_command']);
    expect(testLogger.hasMessage('Command failed:', 'error')).toBe(true);
    expect(
      testLogger.hasMessage('Unknown command: "unknown_command"', 'error'),
    ).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);

    // Invalid option format
    testLogger.clear();
    await runCli(['--port', '8080']);
    expect(testLogger.hasMessage('Command failed:', 'error')).toBe(true);
    expect(
      testLogger.hasMessage(/Unknown or invalid option: "--port"/, 'error'),
    ).toBe(true);

    exitSpy.mockRestore();
  });

  it('should route subcommands correctly (apps, tables, users)', async () => {
    // Apps command
    await runCli(['apps', 'add', 'my-app', `--sqlite=${tmpDir}`]);
    expect(testLogger.hasMessage('Created application: my-app')).toBe(true);

    // Tables command
    testLogger.clear();
    await runCli(['tables', 'add', 'my-app', 'items', `--sqlite=${tmpDir}`]);
    expect(
      testLogger.hasMessage('Added table "items" to application "my-app"'),
    ).toBe(true);

    // Users command
    testLogger.clear();
    await runCli(['users', 'add', 'alice', 'secret', `--sqlite=${tmpDir}`]);
    expect(testLogger.hasMessage('Created user: [')).toBe(true);

    // Status command
    testLogger.clear();
    await runCli(['status', `--sqlite=${tmpDir}`]);
    expect(testLogger.hasMessage('TetherDB Storage Status:')).toBe(true);

    // Maintenance command
    testLogger.clear();
    await runCli(['maintenance', 'vacuum', `--sqlite=${tmpDir}`]);
    expect(testLogger.hasMessage('Vacuum completed successfully')).toBe(true);

    // Help command
    testLogger.clear();
    await runCli(['help']);
    expect(testLogger.hasMessage('TetherDB CLI')).toBe(true);
  });

  it('should use default process.argv when called without arguments', async () => {
    const originalArgv = process.argv;
    try {
      process.argv = ['node', 'cli.js', '--help'];
      testLogger.clear();
      await runCli();
      expect(testLogger.hasMessage('TetherDB CLI')).toBe(true);
    } finally {
      process.argv = originalArgv;
    }
  });

  it('should cleanly close storage when an error occurs during command execution', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as unknown as (
        code?: string | number | null | undefined,
      ) => never);

    testLogger.clear();
    // tables rm on non-existent app throws TetherServerError
    await runCli([
      'tables',
      'rm',
      'non-existent-app',
      'users',
      `--sqlite=${tmpDir}`,
    ]);
    expect(testLogger.hasMessage('Command failed:', 'error')).toBe(true);
    expect(
      testLogger.hasMessage(
        'Application "non-existent-app" not found',
        'error',
      ),
    ).toBe(true);
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
  });
});
