import * as crypto from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
 * Options for configuring the filesystem authentication adapter.
 */
export interface FileAuthOptions {
  /** Optional base directory to house default user accounts (`users.json`) and signing secret (`secret.key`). */
  baseDir?: string;
  /** Explicit file path for persisting user accounts JSON (overrides baseDir default). */
  usersFilePath?: string;
  /** Explicit file path for persisting or loading the token signing secret (overrides baseDir default). */
  secretFilePath?: string;
  /** Secret key for HMAC token signing (auto-generated or loaded from secretFilePath if omitted). */
  tokenSecret?: string;
}

/**
 * Filesystem-backed implementation of `AuthAdapter` persisting user accounts and
 * signing secrets to disk. Handles automatic directory creation and secret persistence.
 */
export class FileAuthAdapter implements AuthAdapter {
  private users: Map<string, UserAccount> = new Map(); // username (lowercase) -> UserAccount
  private usersById: Map<string, UserAccount> = new Map(); // id -> UserAccount
  private usersFilePath?: string;
  private secretFilePath?: string;
  private customTokenSecretProvided: boolean;
  private tokenSecret: string;
  private isLoaded = false;
  private saveLock: Promise<void> = Promise.resolve();

  /**
   * Initializes a new FileAuthAdapter instance.
   *
   * @param options - Filesystem auth configuration options.
   */
  constructor(options: FileAuthOptions = {}) {
    const base = options.baseDir ? path.resolve(options.baseDir) : undefined;

    this.usersFilePath = options.usersFilePath
      ? path.resolve(options.usersFilePath)
      : base
        ? path.join(base, 'users.json')
        : undefined;

    this.secretFilePath = options.secretFilePath
      ? path.resolve(options.secretFilePath)
      : base
        ? path.join(base, 'secret.key')
        : undefined;

    this.customTokenSecretProvided = options.tokenSecret !== undefined;

    let secret = options.tokenSecret;
    if (!secret && this.secretFilePath) {
      try {
        const raw = fsSync.readFileSync(this.secretFilePath, 'utf-8').trim();
        if (raw.length > 0) {
          secret = raw;
        }
      } catch {
        // Will write file below
      }
    }

    this.tokenSecret = secret ?? generateTokenSecret('tetherdb-file');

    if (this.secretFilePath && !this.customTokenSecretProvided && !secret) {
      try {
        const dir = path.dirname(this.secretFilePath);
        fsSync.mkdirSync(dir, { recursive: true });
        fsSync.writeFileSync(this.secretFilePath, this.tokenSecret, 'utf-8');
      } catch {
        // In-memory fallback
      }
    }
  }

  /**
   * Loads persisted user accounts and signing secret from disk if paths were configured.
   */
  async init(): Promise<void> {
    if (this.isLoaded) return;

    if (this.usersFilePath) {
      try {
        const raw = await fs.readFile(this.usersFilePath, 'utf-8');
        const list: UserAccount[] = JSON.parse(raw);
        for (const u of list) {
          this.users.set(u.username.toLowerCase(), u);
          this.usersById.set(u.id, u);
        }
      } catch {
        // File doesn't exist yet or is empty
      }
    }
    this.isLoaded = true;
  }

  private async persist(): Promise<void> {
    if (!this.usersFilePath) return;

    // Chain saves to avoid concurrent write file interleaving
    this.saveLock = this.saveLock.then(async () => {
      if (!this.usersFilePath) return;
      const dir = path.dirname(this.usersFilePath);
      await fs.mkdir(dir, { recursive: true });
      const list = Array.from(this.users.values());
      const tempPath = `${this.usersFilePath}.tmp.${crypto.randomUUID()}`;
      await fs.writeFile(tempPath, JSON.stringify(list, null, 2), 'utf-8');
      await fs.rename(tempPath, this.usersFilePath);
    });

    await this.saveLock;
  }

  /**
   * Registers a new user account with scrypt password hashing, persists it to disk,
   * and returns an authentication token.
   *
   * @param username - Desired username (at least 2 characters).
   * @param password - Account password (at least 4 characters).
   * @returns A promise resolving to the authenticated session with signed token.
   */
  async register(username: string, password: string): Promise<AuthToken> {
    await this.init();
    const cleanUsername = validateUsername(username);

    if (this.users.has(cleanUsername)) {
      throw new Error('Username already exists');
    }

    const account = createUserAccount(cleanUsername, password);

    this.users.set(cleanUsername, account);
    this.usersById.set(account.id, account);
    await this.persist();

    const token = this.generateToken(account.id, account.username);
    return {
      userId: account.id,
      username: account.username,
      token,
    };
  }

  /**
   * Authenticates user credentials and returns a signed session token.
   * Updates the user's `lastLoginAt` timestamp in memory and on disk upon success.
   *
   * @param username - Account username.
   * @param password - Account password.
   * @returns A promise resolving to the authenticated session with signed token.
   */
  async login(username: string, password: string): Promise<AuthToken> {
    await this.init();
    const cleanUsername = validateUsername(username);
    const account = this.users.get(cleanUsername);

    if (
      !account ||
      !verifyPassword(password, account.salt, account.passwordHash)
    ) {
      throw new Error('Invalid username or password');
    }

    account.lastLoginAt = Date.now();
    await this.persist();

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
    await this.init();
    return this.usersById.get(id);
  }

  /**
   * Resolves a user account by username.
   *
   * @param username - User account username.
   * @returns A promise resolving to the UserAccount if found, or `undefined`.
   */
  async getUserByUsername(username: string): Promise<UserAccount | undefined> {
    await this.init();
    const clean = normalizeUsername(username);
    return this.users.get(clean);
  }
}
