import { normalizeUsername, validateUsername } from '../../shared/sanitize.js';
import type {
  AuthAdapter,
  AuthSession,
  AuthToken,
  UserAccount,
} from './adapter.js';
import {
  createUserAccount,
  generateSessionToken,
  generateTokenSecret,
  verifyPassword,
  verifySessionToken,
} from './crypto.js';

/**
 * Options for configuring the in-memory authentication adapter.
 */
export interface MemoryAuthOptions {
  /** Secret key for HMAC token signing (auto-generated if omitted). */
  tokenSecret?: string;
}

/**
 * In-memory implementation of `AuthAdapter` providing user registration,
 * credential verification, and HMAC-signed session tokens without persistent storage.
 * Ideal for unit testing and ephemeral runtime environments.
 */
export class MemoryAuthAdapter implements AuthAdapter {
  private users: Map<string, UserAccount> = new Map(); // username (lowercase) -> UserAccount
  private usersById: Map<string, UserAccount> = new Map(); // id -> UserAccount
  private tokenSecret: string;

  /**
   * Initializes a new MemoryAuthAdapter instance.
   *
   * @param options - In-memory auth configuration options.
   */
  constructor(options: MemoryAuthOptions = {}) {
    this.tokenSecret =
      options.tokenSecret ?? generateTokenSecret('tetherdb-mem');
  }

  /**
   * Registers a new user account with scrypt password hashing and returns an authentication token.
   *
   * @param username - Desired username (at least 2 characters).
   * @param password - Account password (at least 4 characters).
   * @returns A promise resolving to the authenticated session with signed token.
   */
  async register(username: string, password: string): Promise<AuthToken> {
    const cleanUsername = validateUsername(username);

    if (this.users.has(cleanUsername)) {
      throw new Error('Username already exists');
    }

    const account = createUserAccount(cleanUsername, password);

    this.users.set(cleanUsername, account);
    this.usersById.set(account.id, account);

    const token = this.generateToken(account.id, account.username);
    return {
      userId: account.id,
      username: account.username,
      token,
    };
  }

  /**
   * Authenticates user credentials and returns a signed session token.
   * Updates the user's `lastLoginAt` timestamp upon successful authentication.
   *
   * @param username - Account username.
   * @param password - Account password.
   * @returns A promise resolving to the authenticated session with signed token.
   */
  async login(username: string, password: string): Promise<AuthToken> {
    const cleanUsername = validateUsername(username);
    const account = this.users.get(cleanUsername);

    if (
      !account ||
      !verifyPassword(password, account.salt, account.passwordHash)
    ) {
      throw new Error('Invalid username or password');
    }

    account.lastLoginAt = Date.now();

    const token = this.generateToken(account.id, account.username);
    return {
      userId: account.id,
      username: account.username,
      token,
    };
  }

  /**
   * Generates a signed HMAC-SHA256 authentication session token.
   *
   * @param userId - Target user account identifier.
   * @param username - Authenticated username.
   * @returns Base64url-encoded signed token string.
   */
  generateToken(userId: string, username: string): string {
    return generateSessionToken({ userId, username }, this.tokenSecret);
  }

  /**
   * Verifies an HMAC-signed authentication session token and returns the decoded session payload.
   *
   * @param token - Base64url-encoded signed session token.
   * @returns A promise resolving to the decoded `AuthSession` object, or `null` if invalid or expired.
   */
  async verifyToken(token: string): Promise<AuthSession | null> {
    return verifySessionToken(token, this.tokenSecret);
  }

  /**
   * Resolves a user account by unique user ID.
   *
   * @param id - User identifier.
   * @returns A promise resolving to the UserAccount if found, or `undefined`.
   */
  async getUserById(id: string): Promise<UserAccount | undefined> {
    return this.usersById.get(id);
  }

  /**
   * Resolves a user account by username.
   *
   * @param username - User account username.
   * @returns A promise resolving to the UserAccount if found, or `undefined`.
   */
  async getUserByUsername(username: string): Promise<UserAccount | undefined> {
    const clean = normalizeUsername(username);
    return this.users.get(clean);
  }

  /**
   * Clears all in-memory user accounts.
   */
  clear(): void {
    this.users.clear();
    this.usersById.clear();
  }
}
