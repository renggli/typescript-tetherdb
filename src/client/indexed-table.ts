import type { StoredRecord } from '../shared/types.js';
import type { Storage } from './storage.js';
import type { Table } from './table.js';

/**
 * Options for configuring an index on a table.
 */
export interface IndexOptions {
  /** Whether values in this index must be unique. Defaults to `false`. */
  unique?: boolean;
  /** For array properties, whether to index each array element separately. Defaults to `false`. */
  multiEntry?: boolean;
}

/**
 * Direction for cursor iteration over an index.
 */
export type IndexDirection = 'next' | 'nextunique' | 'prev' | 'prevunique';

/**
 * Query options for pagination and direction when reading from an index.
 */
export interface IndexQueryOptions {
  /** Maximum number of records to return. */
  limit?: number;
  /** Number of records to skip before returning. */
  offset?: number;
  /** Cursor iteration direction (e.g. `'next'`, `'prev'`, `'nextunique'`, `'prevunique'`). */
  direction?: IndexDirection;
}

/**
 * Helper utility for building `IDBKeyRange` instances.
 */
export const IndexRange = {
  /**
   * Creates a key range matching only the specified value.
   *
   * @param value - Target key value.
   * @returns An `IDBKeyRange` instance.
   */
  only<K extends IDBValidKey>(value: K): IDBKeyRange {
    return IDBKeyRange.only(value);
  },

  /**
   * Creates a bounded key range between `lower` and `upper`.
   *
   * @param lower - Lower bound key.
   * @param upper - Upper bound key.
   * @param lowerOpen - Whether lower bound is exclusive.
   * @param upperOpen - Whether upper bound is exclusive.
   * @returns An `IDBKeyRange` instance.
   */
  bound<K extends IDBValidKey>(
    lower: K,
    upper: K,
    lowerOpen = false,
    upperOpen = false,
  ): IDBKeyRange {
    return IDBKeyRange.bound(lower, upper, lowerOpen, upperOpen);
  },

  /**
   * Creates a key range with a lower bound.
   *
   * @param lower - Lower bound key.
   * @param open - Whether lower bound is exclusive.
   * @returns An `IDBKeyRange` instance.
   */
  lowerBound<K extends IDBValidKey>(lower: K, open = false): IDBKeyRange {
    return IDBKeyRange.lowerBound(lower, open);
  },

  /**
   * Creates a key range with an upper bound.
   *
   * @param upper - Upper bound key.
   * @param open - Whether upper bound is exclusive.
   * @returns An `IDBKeyRange` instance.
   */
  upperBound<K extends IDBValidKey>(upper: K, open = false): IDBKeyRange {
    return IDBKeyRange.upperBound(upper, open);
  },

  /**
   * Creates a key range matching all string values starting with `prefix`.
   *
   * @param prefix - String prefix to match.
   * @returns An `IDBKeyRange` instance.
   */
  startsWith(prefix: string): IDBKeyRange {
    return IDBKeyRange.bound(prefix, `${prefix}\uffff`, false, false);
  },
};

/**
 * First-class index definition representing a single index schema on a table.
 *
 * @typeParam K - The key type of the indexed property.
 */
export class Index<K = IDBValidKey> {
  /** Phantom type marker preserving the index key type `K`. */
  declare readonly _keyType: K;
  /** Unique name identifier for the index. */
  readonly name: string;
  /** Property path (or array of paths for compound indexes) to index. */
  readonly keyPath: string | string[];
  /** Whether the index enforces uniqueness. */
  readonly unique: boolean;
  /** For array properties, whether to index each element separately. */
  readonly multiEntry: boolean;

  /**
   * Creates a new Index definition.
   *
   * @param name - Index name identifier.
   * @param keyPath - Field path (e.g. `'email'`, `'profile.age'`) or compound paths (e.g. `['status', 'createdAt']`).
   * @param options - Additional index configuration options (unique, multiEntry).
   */
  constructor(
    name: string,
    keyPath: string | string[],
    options: IndexOptions = {},
  ) {
    this.name = name;
    this.keyPath = keyPath;
    this.unique = options.unique ?? false;
    this.multiEntry = options.multiEntry ?? false;
  }
}

/**
 * Bound indexed view on a Table providing index-aware queries and reactive subscriptions.
 *
 * @typeParam T - The data type of records stored in the parent table.
 * @typeParam K - The key type of the index.
 */
export class IndexedTable<T = unknown, K = IDBValidKey> {
  /** The parent table reference. */
  readonly table: Table<T>;
  /** The underlying index definition. */
  readonly index: Index<K>;

  /**
   * Creates a new IndexedTable view.
   *
   * @param table - Parent Table instance.
   * @param index - Index definition.
   */
  constructor(table: Table<T>, index: Index<K>) {
    this.table = table;
    this.index = index;
  }

  /**
   * The name of the index.
   */
  get name(): string {
    return this.index.name;
  }

  /**
   * The key path of the index.
   */
  get keyPath(): string | string[] {
    return this.index.keyPath;
  }

  /**
   * Whether the index enforces unique constraints.
   */
  get unique(): boolean {
    return this.index.unique;
  }

  /**
   * Whether multi-entry is enabled for array values.
   */
  get multiEntry(): boolean {
    return this.index.multiEntry;
  }

  /**
   * Retrieves the first record payload matching the specified key or key range.
   *
   * @param query - The key value or `IDBKeyRange` to search for.
   * @returns A promise resolving to the record data payload, or `undefined` if not found.
   */
  async get(query: K | IDBKeyRange): Promise<T | undefined> {
    const record = await this.storage.getFromIndex<T>(
      this.table.name,
      this.index.name,
      query as unknown as IDBValidKey | IDBKeyRange,
    );
    return record?.data;
  }

  /**
   * Retrieves the first stored record including metadata matching the specified key or key range.
   *
   * @param query - The key value or `IDBKeyRange` to search for.
   * @returns A promise resolving to the stored record with metadata, or `undefined` if not found.
   */
  async getWithMetadata(
    query: K | IDBKeyRange,
  ): Promise<StoredRecord<T> | undefined> {
    return this.storage.getFromIndex<T>(
      this.table.name,
      this.index.name,
      query as unknown as IDBValidKey | IDBKeyRange,
    );
  }

  /**
   * Retrieves all record data payloads matching the specified query or key range.
   *
   * @param query - Optional key value or `IDBKeyRange` filter. If omitted, retrieves all indexed records.
   * @param options - Pagination and cursor direction options.
   * @returns A promise resolving to an array of record data objects.
   */
  async getAll(
    query?: K | IDBKeyRange,
    options?: IndexQueryOptions,
  ): Promise<T[]> {
    const records = await this.storage.getAllFromIndex<T>(
      this.table.name,
      this.index.name,
      query as unknown as IDBValidKey | IDBKeyRange | undefined,
      options,
    );
    return records.map((r) => r.data);
  }

  /**
   * Retrieves all stored records with metadata matching the specified query or key range.
   *
   * @param query - Optional key value or `IDBKeyRange` filter. If omitted, retrieves all indexed records.
   * @param options - Pagination and cursor direction options.
   * @returns A promise resolving to an array of stored records with metadata.
   */
  async getAllWithMetadata(
    query?: K | IDBKeyRange,
    options?: IndexQueryOptions,
  ): Promise<StoredRecord<T>[]> {
    return this.storage.getAllFromIndex<T>(
      this.table.name,
      this.index.name,
      query as unknown as IDBValidKey | IDBKeyRange | undefined,
      options,
    );
  }

  /**
   * Counts the number of records matching the specified key or key range.
   *
   * @param query - Optional key value or `IDBKeyRange` filter.
   * @returns A promise resolving to the matching count.
   */
  async count(query?: K | IDBKeyRange): Promise<number> {
    return this.storage.countFromIndex(
      this.table.name,
      this.index.name,
      query as unknown as IDBValidKey | IDBKeyRange | undefined,
    );
  }

  /**
   * Retrieves index keys matching the specified query or key range.
   *
   * @param query - Optional key value or `IDBKeyRange` filter.
   * @param options - Pagination and cursor direction options.
   * @returns A promise resolving to an array of index keys.
   */
  async getKeys(
    query?: K | IDBKeyRange,
    options?: IndexQueryOptions,
  ): Promise<IDBValidKey[]> {
    return this.storage.getKeysFromIndex(
      this.table.name,
      this.index.name,
      query as unknown as IDBValidKey | IDBKeyRange | undefined,
      options,
    );
  }

  /**
   * Retrieves primary record identifiers (IDs) matching the specified query or key range.
   *
   * @param query - Optional key value or `IDBKeyRange` filter.
   * @param options - Pagination and cursor direction options.
   * @returns A promise resolving to an array of primary record identifiers.
   */
  async getPrimaryKeys(
    query?: K | IDBKeyRange,
    options?: IndexQueryOptions,
  ): Promise<string[]> {
    return this.storage.getPrimaryKeysFromIndex(
      this.table.name,
      this.index.name,
      query as unknown as IDBValidKey | IDBKeyRange | undefined,
      options,
    );
  }

  /**
   * Reactively subscribes to records matching the specified query in this index.
   * Immediately invokes the listener with the matching records, and re-invokes it
   * whenever any local or remote mutations occur on the table.
   *
   * @param query - Optional key value or `IDBKeyRange` filter.
   * @param listener - Callback receiving the latest array of matching records.
   * @param options - Pagination and cursor direction options.
   * @returns An unsubscribe function.
   */
  subscribe(
    query: K | IDBKeyRange | undefined,
    listener: (items: T[]) => void,
    options?: IndexQueryOptions,
  ): () => void {
    let isActive = true;
    let currentVersion = 0;
    const fetchAndNotify = () => {
      const version = ++currentVersion;
      this.getAll(query, options)
        .then((items) => {
          if (isActive && version === currentVersion) {
            listener(items);
          }
        })
        .catch(() => {
          // Ignore fetch error during unmounted subscription initialization
        });
    };

    fetchAndNotify();
    const unsubscribe = this.table.onChange.register(() => {
      fetchAndNotify();
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }

  // -- Private Helpers ------------------------------------------------------

  private get storage(): Storage {
    return this.table.storageInstance;
  }
}
