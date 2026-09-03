import * as crypto from 'node:crypto';
import { TetherServerError, TetherServerErrorCode } from '../errors.js';
import {
  createSessionToken,
  hashPassword,
  verifyPasswordHash,
  verifySessionToken,
} from '../shared/crypto.js';
import { normalizePassword, validatePassword } from '../shared/validate.js';
import type { Storage } from './storage.js';

/**
 * Public User principal contract representing an actor across server operations.
 */
export interface User {
  /** Unique user identifier. */
  readonly userId: string;
  /** Normalized username. */
  readonly userName: string;
  /** Epoch creation timestamp. */
  readonly createdAt: number;
  /** True if the user is authenticated (not anonymous). */
  readonly isAuthenticated: boolean;
  /** True if the user has administrative privileges. */
  readonly isAdmin: boolean;
  /** True if the user represents an unauthenticated guest. */
  readonly isAnonymous: boolean;

  /**
   * Verifies if the provided plaintext password matches the stored credentials.
   *
   * @param password - Plaintext password to verify.
   * @returns True if password matches.
   */
  verifyPassword(password: string): Promise<boolean>;

  /**
   * Changes the user's password.
   *
   * @param newPassword - New plaintext password.
   */
  changePassword(newPassword: string): Promise<void>;

  /**
   * Creates a signed session token for this user.
   *
   * @param expiresInSeconds - Optional duration before token expires.
   * @returns Signed token string.
   */
  createToken(expiresInSeconds?: number): Promise<string>;

  /**
   * Verifies if a session token is valid for this user.
   *
   * @param token - Token string to verify.
   * @returns True if valid and not expired.
   */
  verifyToken(token: string): Promise<boolean>;

  /**
   * Deletes this user account and all of their data.
   *
   * @returns True if deleted successfully.
   */
  delete(): Promise<boolean>;
}

/**
 * Companion namespace/object providing standard system singletons.
 */
export const User = {
  /** Dedicated singleton representing an unauthenticated guest connection. */
  get Anonymous(): User {
    return anonymousUserSingleton;
  },
  /** Dedicated singleton representing an administrative actor with full privileges. */
  get Admin(): User {
    return adminUserSingleton;
  },
} as const;

/**
 * Internal factory function for storage engines to create authenticated user instances.
 *
 * @param userId - Unique user identifier.
 * @param userName - Normalized username.
 * @param createdAt - Epoch creation timestamp.
 * @param storage - Underlying storage backend.
 * @returns An authenticated User instance.
 */
export function createAuthenticatedUser(
  userId: string,
  userName: string,
  createdAt: number,
  storage: Storage,
): User {
  return new AuthenticatedUser(userId, userName, createdAt, storage);
}

// -- Private User Implementations --------------------------------------------

class AuthenticatedUser implements User {
  readonly isAuthenticated = true;
  readonly isAdmin = false;
  readonly isAnonymous = false;

  constructor(
    readonly userId: string,
    readonly userName: string,
    readonly createdAt: number,
    private readonly storage: Storage,
  ) {}

  async verifyPassword(password: string): Promise<boolean> {
    const passwordHash = await this.storage.getUserPasswordHash(this.userId);
    if (passwordHash === undefined) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        'User not found',
      );
    }
    if (!passwordHash) return false;
    const normalized = normalizePassword(password);
    if (!normalized) return false;
    return verifyPasswordHash(normalized, passwordHash);
  }

  async changePassword(newPassword: string): Promise<void> {
    const valid = validatePassword(newPassword);
    const newHash = await hashPassword(valid);
    await this.storage.setUserPasswordHash(this.userId, newHash);
  }

  async createToken(expiresInSeconds?: number): Promise<string> {
    const passwordHash = await this.storage.getUserPasswordHash(this.userId);
    return createSessionToken(
      this.userId,
      this.userName,
      this.storage.secret,
      expiresInSeconds,
      passwordHash,
    );
  }

  async verifyToken(token: string): Promise<boolean> {
    const payload = verifySessionToken(token, this.storage.secret);
    if (payload === null || payload.userId !== this.userId) return false;
    const passwordHash = await this.storage.getUserPasswordHash(this.userId);
    if (passwordHash) {
      const expectedPwd = crypto
        .createHash('sha256')
        .update(passwordHash)
        .digest('hex')
        .slice(0, 16);
      if (!payload.pwd || payload.pwd !== expectedPwd) {
        return false;
      }
    }
    return true;
  }

  async delete(): Promise<boolean> {
    return this.storage.deleteUser(this.userId);
  }
}

class AdminUser implements User {
  readonly userId = '';
  readonly userName = '';
  readonly createdAt = 0;
  readonly isAuthenticated = true;
  readonly isAdmin = true;
  readonly isAnonymous = false;

  async verifyPassword(): Promise<boolean> {
    return false;
  }

  async changePassword(): Promise<void> {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      'Operation not supported for admin user',
    );
  }

  async createToken(): Promise<string> {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      'Operation not supported for admin user',
    );
  }

  async verifyToken(): Promise<boolean> {
    return false;
  }

  async delete(): Promise<boolean> {
    return false;
  }
}

class AnonymousUser implements User {
  readonly userId = '';
  readonly userName = '';
  readonly createdAt = 0;
  readonly isAuthenticated = false;
  readonly isAdmin = false;
  readonly isAnonymous = true;

  async verifyPassword(): Promise<boolean> {
    return false;
  }

  async changePassword(): Promise<void> {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      'Operation not supported for anonymous user',
    );
  }

  async createToken(): Promise<string> {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      'Operation not supported for anonymous user',
    );
  }

  async verifyToken(): Promise<boolean> {
    return false;
  }

  async delete(): Promise<boolean> {
    return false;
  }
}

const anonymousUserSingleton: User = new AnonymousUser();
const adminUserSingleton: User = new AdminUser();
