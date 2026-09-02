import type { ChangeRecord } from '../../shared/types.js';
import type { Storage } from '../storage/storage.js';
import type { User } from '../storage/user.js';
import type { InternalChangeRecord } from './types.js';

/**
 * In-memory caching resolver mapping user IDs to usernames during batch operations.
 */
export class UserResolver {
  private readonly storage: Storage;
  private readonly cache = new Map<string, string>();

  /**
   * Initializes a new UserResolver instance.
   *
   * @param storage - Storage engine used for database lookups.
   */
  constructor(storage: Storage) {
    this.storage = storage;
  }

  /**
   * Primes the cache with a known user ID to username mapping.
   *
   * @param userId - Unique user identifier.
   * @param userName - Corresponding username.
   */
  prime(userId: string, userName: string): void {
    this.cache.set(userId, userName);
  }

  /**
   * Resolves a user ID to its username, leveraging cache and fallback context.
   *
   * @param userId - Unique user identifier to resolve.
   * @param fallbackUser - Optional authenticated user context.
   * @returns Resolved username or `undefined` if not found.
   */
  async resolveUserName(
    userId?: string,
    fallbackUser?: User,
  ): Promise<string | undefined> {
    if (!userId) return undefined;
    if (fallbackUser && fallbackUser.userId === userId) {
      this.cache.set(userId, fallbackUser.userName);
      return fallbackUser.userName;
    }
    const cached = this.cache.get(userId);
    if (cached !== undefined) return cached;

    const found = await this.storage.getUser(userId);
    if (found) {
      this.cache.set(userId, found.userName);
      return found.userName;
    }

    return undefined;
  }

  /**
   * Converts internal change records into public change records, resolving author usernames.
   *
   * @param changes - Array of internal change records.
   * @param fallbackUser - Optional authenticated user context.
   * @returns Array of public ChangeRecord items.
   */
  async resolvePublicChanges(
    changes: InternalChangeRecord[],
    fallbackUser?: User,
  ): Promise<ChangeRecord[]> {
    const publicApplied: ChangeRecord[] = [];
    for (const applied of changes) {
      const userName = await this.resolveUserName(applied.userId, fallbackUser);
      publicApplied.push({
        table: applied.table,
        id: applied.id,
        op: applied.op,
        data: applied.data,
        version: applied.version,
        seq: applied.seq,
        timestamp: applied.timestamp,
        clientId: applied.clientId,
        userName,
      });
    }
    return publicApplied;
  }
}
