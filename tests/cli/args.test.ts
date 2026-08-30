import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCliArgs } from '../../src/cli/args.js';
import {
  TetherServerError,
  TetherServerErrorCode,
} from '../../src/server/errors.js';
import { StorageType } from '../../src/server/storage/storage.js';

describe('parseCliArgs', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.PORT;
    delete process.env.HOST;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should parse default options when args are empty', () => {
    const result = parseCliArgs([]);
    expect(result).toEqual({
      command: 'serve',
      positionalArgs: [],
      backend: StorageType.Memory,
      dir: '.data',
      host: '0.0.0.0',
      port: 8080,
    });
  });

  it('should read PORT and HOST from environment variables by default', () => {
    process.env.PORT = '9000';
    process.env.HOST = '127.0.0.1';
    const result = parseCliArgs([]);
    expect(result.port).toBe(9000);
    expect(result.host).toBe('127.0.0.1');
  });

  it('should parse port and host flags with equals and space syntax', () => {
    const result1 = parseCliArgs(['--port=3000', '--host=127.0.0.1']);
    expect(result1.port).toBe(3000);
    expect(result1.host).toBe('127.0.0.1');

    const result2 = parseCliArgs(['-p', '4000', '-H', 'localhost']);
    expect(result2.port).toBe(4000);
    expect(result2.host).toBe('localhost');

    const result3 = parseCliArgs(['--port', '5000', '--host', '0.0.0.0']);
    expect(result3.port).toBe(5000);
    expect(result3.host).toBe('0.0.0.0');
  });

  it('should parse backend options (-b, --backend, --memory, --file, --sqlite)', () => {
    const memResult = parseCliArgs(['--memory']);
    expect(memResult.backend).toBe(StorageType.Memory);
    expect(memResult.token).toBeUndefined();

    const memTokenResult1 = parseCliArgs(['--memory=abc123token']);
    expect(memTokenResult1.backend).toBe(StorageType.Memory);
    expect(memTokenResult1.token).toBe('abc123token');

    const memTokenResult2 = parseCliArgs(['--memory', 'xyz789token']);
    expect(memTokenResult2.backend).toBe(StorageType.Memory);
    expect(memTokenResult2.token).toBe('xyz789token');

    const tokenResult1 = parseCliArgs(['--token=custom-token']);
    expect(tokenResult1.token).toBe('custom-token');

    const tokenResult2 = parseCliArgs(['-t', 'custom-token-2']);
    expect(tokenResult2.token).toBe('custom-token-2');

    const bResult = parseCliArgs(['-b', 'sqlite', '-d', '/custom/path']);
    expect(bResult.backend).toBe(StorageType.Sqlite);
    expect(bResult.dir).toBe('/custom/path');

    const backendResult = parseCliArgs(['--backend=file', '--dir=/file/path']);
    expect(backendResult.backend).toBe(StorageType.File);
    expect(backendResult.dir).toBe('/file/path');

    const fileResult1 = parseCliArgs(['--file']);
    expect(fileResult1.backend).toBe(StorageType.File);
    expect(fileResult1.dir).toBe('.data');

    const fileResult2 = parseCliArgs(['--file=/custom/path']);
    expect(fileResult2.backend).toBe(StorageType.File);
    expect(fileResult2.dir).toBe('/custom/path');

    const fileResult3 = parseCliArgs(['--file', '/space/path']);
    expect(fileResult3.backend).toBe(StorageType.File);
    expect(fileResult3.dir).toBe('/space/path');

    const sqliteResult1 = parseCliArgs(['--sqlite']);
    expect(sqliteResult1.backend).toBe(StorageType.Sqlite);
    expect(sqliteResult1.dir).toBe('.data');

    const sqliteResult2 = parseCliArgs(['--sqlite=/db/path']);
    expect(sqliteResult2.backend).toBe(StorageType.Sqlite);
    expect(sqliteResult2.dir).toBe('/db/path');

    const sqliteResult3 = parseCliArgs(['--sqlite', '/db/space']);
    expect(sqliteResult3.backend).toBe(StorageType.Sqlite);
    expect(sqliteResult3.dir).toBe('/db/space');
  });

  it('should extract positional arguments and subcommands', () => {
    const result1 = parseCliArgs([
      'tables',
      'add',
      'recipes',
      '--sqlite=.data',
    ]);
    expect(result1.command).toBe('tables');
    expect(result1.positionalArgs).toEqual(['tables', 'add', 'recipes']);
    expect(result1.backend).toBe(StorageType.Sqlite);

    const result2 = parseCliArgs(['tables', 'list']);
    expect(result2.command).toBe('tables');
    expect(result2.positionalArgs).toEqual(['tables', 'list']);

    const result3 = parseCliArgs(['users', 'list']);
    expect(result3.command).toBe('users');
    expect(result3.positionalArgs).toEqual(['users', 'list']);

    const result4 = parseCliArgs(['records', 'list', 'recipes']);
    expect(result4.command).toBe('records');
    expect(result4.positionalArgs).toEqual(['records', 'list', 'recipes']);
  });

  it('should throw an error on unknown flags starting with dash or invalid backend', () => {
    expect(() => parseCliArgs(['--unknown-flag'])).toThrow(TetherServerError);

    expect(() => parseCliArgs(['-b', 'invalid'])).toThrow(TetherServerError);

    try {
      parseCliArgs(['--unknown-option']);
    } catch (err) {
      expect((err as TetherServerError).code).toBe(
        TetherServerErrorCode.ConfigurationError,
      );
      expect((err as Error).message).toContain(
        'Unknown or invalid option: "--unknown-option"',
      );
    }
  });
});
