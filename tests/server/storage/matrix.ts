import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  FileStorage,
  type FileStorageOptions,
} from '../../../src/server/storage/file.js';
import {
  MemoryStorage,
  type MemoryStorageOptions,
} from '../../../src/server/storage/memory.js';
import {
  SqliteStorage,
  type SqliteStorageOptions,
} from '../../../src/server/storage/sqlite.js';
import type {
  Storage,
  StorageOptions,
} from '../../../src/server/storage/storage.js';

/**
 * Context holding an instantiated storage backend and its cleanup handler.
 */
export interface StorageContext<T extends Storage = Storage> {
  /** Instantiated storage backend instance. */
  readonly backend: T;
  /** Alias for `backend`. */
  readonly storage: T;
  /** Closes backend connections and deletes any temporary directories. */
  readonly cleanup: () => Promise<void>;
}

/**
 * Context for file-based storage backends with a dedicated filesystem directory.
 */
export interface FileBasedStorageContext<T extends Storage = Storage>
  extends StorageContext<T> {
  /** Filesystem directory path created for this storage instance. */
  readonly dir: string;
}

/**
 * Storage backend descriptor providing metadata and instance factory.
 */
export interface StorageDescriptor<
  T extends Storage = Storage,
  TOptions extends StorageOptions = StorageOptions,
  TContext extends StorageContext<T> = StorageContext<T>,
> {
  /** Name of the backend ('memory', 'file', 'sqlite', or 'sqlite (memory)'). */
  readonly name: string;
  /** Factory method creating backend instance and its cleanup handler. */
  readonly createBackend: (options?: TOptions) => Promise<TContext>;
}

/**
 * In-memory storage backend descriptor.
 */
export const memoryStorage: StorageDescriptor<
  MemoryStorage,
  MemoryStorageOptions
> = {
  name: 'memory',
  async createBackend(
    options?: MemoryStorageOptions,
  ): Promise<StorageContext<MemoryStorage>> {
    const backend = new MemoryStorage(options);
    return {
      backend,
      storage: backend,
      cleanup: async () => {
        await backend.close();
      },
    };
  },
};

/**
 * In-memory SQLite storage backend descriptor.
 */
export const sqliteMemoryStorage: StorageDescriptor<
  SqliteStorage,
  SqliteStorageOptions
> = {
  name: 'sqlite (memory)',
  async createBackend(
    options?: SqliteStorageOptions,
  ): Promise<StorageContext<SqliteStorage>> {
    const backend = new SqliteStorage({ inMemory: true, ...options });
    return {
      backend,
      storage: backend,
      cleanup: async () => {
        await backend.close();
      },
    };
  },
};

/**
 * File-based SQLite storage backend descriptor with temporary directory lifecycle.
 */
export const sqliteStorage: StorageDescriptor<
  SqliteStorage,
  SqliteStorageOptions,
  FileBasedStorageContext<SqliteStorage>
> = {
  name: 'sqlite',
  async createBackend(
    options?: SqliteStorageOptions,
  ): Promise<FileBasedStorageContext<SqliteStorage>> {
    const dir = path.join(
      os.tmpdir(),
      `tetherdb-sqlite-${Math.random().toString(36).substring(2, 10)}`,
    );
    await fs.mkdir(dir, { recursive: true });
    const backend = new SqliteStorage({ baseDir: dir, ...options });
    return {
      backend,
      storage: backend,
      dir,
      cleanup: async () => {
        await backend.close();
        await fs.rm(dir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 20,
        });
      },
    };
  },
};

/**
 * Filesystem storage backend descriptor with temporary directory lifecycle.
 */
export const fileStorage: StorageDescriptor<
  FileStorage,
  FileStorageOptions,
  FileBasedStorageContext<FileStorage>
> = {
  name: 'file',
  async createBackend(
    options?: FileStorageOptions,
  ): Promise<FileBasedStorageContext<FileStorage>> {
    const dir = path.join(
      os.tmpdir(),
      `tetherdb-file-${Math.random().toString(36).substring(2, 10)}`,
    );
    await fs.mkdir(dir, { recursive: true });
    const backend = new FileStorage({ baseDir: dir, ...options });
    return {
      backend,
      storage: backend,
      dir,
      cleanup: async () => {
        await backend.close();
        await fs.rm(dir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 20,
        });
      },
    };
  },
};

/** List of all implemented storage descriptors. */
export const storageDescriptors: readonly StorageDescriptor[] = [
  memoryStorage,
  sqliteMemoryStorage,
  sqliteStorage,
  fileStorage,
] as const;
