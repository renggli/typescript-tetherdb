import {
  createSessionToken,
  hashPassword,
  verifyPasswordHash,
  verifySessionToken,
} from '../../crypto.js';
import { normalizePassword, validatePassword } from '../../validate.js';
import type { UserStorage } from '../user.js';
import type { BaseStorage } from './storage.js';

/**
 * Common abstract base class for UserStorage implementations.
 */
export abstract class UserBaseStorage<
  TStorage extends BaseStorage = BaseStorage,
> implements UserStorage
{
  readonly id: string;
  readonly username: string;
  readonly createdAt: number;
  protected readonly storage: TStorage;

  constructor(
    id: string,
    username: string,
    createdAt: number,
    storage: TStorage,
  ) {
    this.id = id;
    this.username = username;
    this.createdAt = createdAt;
    this.storage = storage;
  }

  /** Retrieves the secret key used for signing session tokens. */
  protected getSecret(): string {
    return this.storage.secret;
  }

  abstract verifyPassword(password: string): Promise<boolean>;

  abstract changePassword(newPassword: string): Promise<void>;

  async delete(): Promise<boolean> {
    return this.storage.deleteUser(this.id);
  }

  /** Creates a signed session token for this user. */
  async createToken(expiresInSeconds?: number): Promise<string> {
    return createSessionToken(
      this.id,
      this.username,
      this.getSecret(),
      expiresInSeconds,
    );
  }

  /** Verifies whether the session token is valid for this user. */
  async verifyToken(token: string): Promise<boolean> {
    const payload = verifySessionToken(token, this.getSecret());
    return payload !== null && payload.userId === this.id;
  }
}

/**
 * Verifies a candidate plaintext password against a stored bcrypt hash.
 */
export async function verifyUserPassword(
  password: string,
  passwordHash: string | null | undefined,
): Promise<boolean> {
  if (!passwordHash) return false;
  const normalized = normalizePassword(password);
  if (!normalized) return false;
  return verifyPasswordHash(normalized, passwordHash);
}

/**
 * Hashes a validated plaintext password.
 */
export async function hashUserPassword(newPassword: string): Promise<string> {
  const valid = validatePassword(newPassword);
  return hashPassword(valid);
}
