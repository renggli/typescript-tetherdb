import { describe, expect, it } from 'vitest';
import { FileAuthAdapter } from '../../src/server/auth/file.js';
import { MemoryAuthAdapter } from '../../src/server/auth/memory.js';
import { SqliteAuthAdapter } from '../../src/server/auth/sqlite.js';
import { FileStorageAdapter } from '../../src/server/storage/file.js';
import { MemoryStorageAdapter } from '../../src/server/storage/memory.js';
import { SqliteStorageAdapter } from '../../src/server/storage/sqlite.js';
import { parseAuthSpec, parseStorageSpec } from '../../src/server/tetherdb.js';

describe('src/server/tetherdb.ts (CLI spec parsers)', () => {
  describe('parseAuthSpec', () => {
    it('should default to MemoryAuthAdapter when unspecified or set to "memory"', () => {
      expect(parseAuthSpec()).toBeInstanceOf(MemoryAuthAdapter);
      expect(parseAuthSpec('memory')).toBeInstanceOf(MemoryAuthAdapter);
    });

    it('should parse "sqlite" and "sqlite:path" specifications', () => {
      const auth1 = parseAuthSpec('sqlite');
      expect(auth1).toBeInstanceOf(SqliteAuthAdapter);

      const auth2 = parseAuthSpec('sqlite:.custom_dir');
      expect(auth2).toBeInstanceOf(SqliteAuthAdapter);

      const auth3 = parseAuthSpec('sqlite', '.custom_fallback');
      expect(auth3).toBeInstanceOf(SqliteAuthAdapter);
    });

    it('should parse "file" and "file:path" specifications', () => {
      const auth1 = parseAuthSpec('file');
      expect(auth1).toBeInstanceOf(FileAuthAdapter);

      const auth2 = parseAuthSpec('file:.custom_data');
      expect(auth2).toBeInstanceOf(FileAuthAdapter);

      const auth3 = parseAuthSpec('file', '.custom_fallback');
      expect(auth3).toBeInstanceOf(FileAuthAdapter);
    });

    it('should reject invalid auth specifications', () => {
      expect(() => parseAuthSpec('invalid_auth_spec')).toThrow(
        'Unknown auth spec',
      );
    });
  });

  describe('parseStorageSpec', () => {
    it('should default to MemoryStorageAdapter when unspecified or set to "memory"', () => {
      expect(parseStorageSpec()).toBeInstanceOf(MemoryStorageAdapter);
      expect(parseStorageSpec('memory')).toBeInstanceOf(MemoryStorageAdapter);
    });

    it('should parse "sqlite" and "sqlite:path" specifications', () => {
      const storage1 = parseStorageSpec('sqlite');
      expect(storage1).toBeInstanceOf(SqliteStorageAdapter);

      const storage2 = parseStorageSpec('sqlite:.custom_dir');
      expect(storage2).toBeInstanceOf(SqliteStorageAdapter);

      const storage3 = parseStorageSpec('sqlite', '.custom_fallback');
      expect(storage3).toBeInstanceOf(SqliteStorageAdapter);
    });

    it('should parse "file" and "file:path" specifications', () => {
      const storage1 = parseStorageSpec('file');
      expect(storage1).toBeInstanceOf(FileStorageAdapter);

      const storage2 = parseStorageSpec('file:.data_dir');
      expect(storage2).toBeInstanceOf(FileStorageAdapter);

      const storage3 = parseStorageSpec('file', '.custom_fallback');
      expect(storage3).toBeInstanceOf(FileStorageAdapter);
    });

    it('should reject invalid storage specifications', () => {
      expect(() => parseStorageSpec('redis://localhost')).toThrow(
        'Unknown storage spec',
      );
    });
  });
});
