import type { StoredRecord } from '../shared/types.js';
import type { Storage } from './storage.js';
import { getTableStorage, type Table } from './table.js';

/**
 * Options for configuring an index on a table.
 */
export interface IndexOptions {
  /** Optional custom name for the index. Defaults to the string representation of `keyPath`. */
  name?: string;
  /** Whether values in this index must be unique. Defaults to `false`. */
  unique?: boolean;
  /** For array properties, whether to index each array element separately. Defaults to `false`. */
  multiEntry?: boolean;
}

/**
 * Direction for cursor iteration over an index.
 */
export enum IndexDirection {
  /** Forward order iteration. */
  Next = 'next',
  /** Forward order iteration skipping duplicate index keys. */
  NextUnique = 'nextunique',
  /** Reverse order iteration. */
  Prev = 'prev',
  /** Reverse order iteration skipping duplicate index keys. */
  PrevUnique = 'prevunique',
}

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
   * Creates a key range between `lower` and `upper` with configurable inclusivity.
   *
   * @param lower - Lower bound key.
   * @param upper - Upper bound key.
   * @param inclusive - Whether both bounds are inclusive (defaults to `true`).
   * @returns An `IDBKeyRange` instance.
   */
  between<K extends IDBValidKey>(
    lower: K,
    upper: K,
    inclusive = true,
  ): IDBKeyRange {
    return IDBKeyRange.bound(lower, upper, !inclusive, !inclusive);
  },

  /**
   * Creates a key range matching values greater than `lower`.
   *
   * @param lower - Lower bound key.
   * @param inclusive - Whether the bound is inclusive (defaults to `false`).
   * @returns An `IDBKeyRange` instance.
   */
  greaterThan<K extends IDBValidKey>(lower: K, inclusive = false): IDBKeyRange {
    return IDBKeyRange.lowerBound(lower, !inclusive);
  },

  /**
   * Creates a key range matching values less than `upper`.
   *
   * @param upper - Upper bound key.
   * @param inclusive - Whether the bound is inclusive (defaults to `false`).
   * @returns An `IDBKeyRange` instance.
   */
  lessThan<K extends IDBValidKey>(upper: K, inclusive = false): IDBKeyRange {
    return IDBKeyRange.upperBound(upper, !inclusive);
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
 * First-class index definition and query view on a Table.
 *
 * @typeParam T - The data type of records stored in the parent table.
 * @typeParam K - The key type of the indexed property.
 */
export class Index<T = unknown, K = IDBValidKey> {
  /** Phantom type marker preserving the index key type `K`. */
  declare readonly _keyType: K;
  /** Phantom type marker preserving the table record type `T`. */
  declare readonly _dataType: T;

  /** Unique name identifier for the index. */
  readonly name: string;
  /** Property path (or array of paths for compound indexes) to index. */
  readonly keyPath: string | string[];
  /** Whether the index enforces uniqueness. */
  readonly unique: boolean;
  /** For array properties, whether to index each element separately. */
  readonly multiEntry: boolean;
  /** The parent table this index is bound to. */
  readonly table: Table<T>;

  /**
   * Creates a new bound Index instance for a Table.
   *
   * @param keyPath - Field path (e.g. `'email'`, `'profile.age'`) or compound paths (e.g. `['department', 'role']`).
   * @param options - Additional index configuration options (unique, multiEntry, custom name).
   * @param table - Parent Table instance.
   */
  constructor(
    keyPath: string | string[],
    options: IndexOptions,
    table: Table<T>,
  ) {
    this.keyPath = keyPath;
    this.name =
      options.name ?? (Array.isArray(keyPath) ? keyPath.join(',') : keyPath);
    this.unique = options.unique ?? false;
    this.multiEntry = options.multiEntry ?? false;
    this.table = table;
  }

  /**
   * Retrieves the first record payload matching the specified key or key range.
   *
   * @param query - The key value or `IDBKeyRange` to search for.
   * @returns A promise resolving to the record data payload, or `undefined` if not found.
   */
  async get(query: K | IDBKeyRange): Promise<T | undefined> {
    const record = await this.getWithMetadata(query);
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
      this.tableName,
      this.name,
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
    const records = await this.getAllWithMetadata(query, options);
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
      this.tableName,
      this.name,
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
      this.tableName,
      this.name,
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
      this.tableName,
      this.name,
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
      this.tableName,
      this.name,
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
    const table = this.table;
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
    const unsubscribe = table.onChange.register(() => {
      fetchAndNotify();
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }

  // -- Private Helpers ------------------------------------------------------

  private get tableName(): string {
    return this.table.name;
  }

  private get storage(): Storage {
    return getTableStorage(this.table);
  }
}
