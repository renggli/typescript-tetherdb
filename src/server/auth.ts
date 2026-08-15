import * as crypto from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { validateUsername } from '../shared/sanitize.js';

/**
 * Persisted user account credentials and metadata.
 */
export interface UserAccount {
  /** Unique user identifier. */
  id: string;
  /** Unique username. */
  username: string;
  /** Scrypt password hash (hex). */
  passwordHash: string;
  /** Cryptographic salt (hex). */
  salt: string;
  /** Epoch timestamp of user creation. */
  createdAt: number;
  /** Epoch timestamp of the last successful login. */
  lastLoginAt?: number;
}

/**
 * Authenticated user session payload decoded from a verified token.
 */
export interface AuthSession {
  /** Authenticated user identifier. */
  userId: string;
  /** Authenticated username. */
  username: string;
}

/**
 * Options for configuring the AuthManager.
 */
export interface AuthManagerOptions {
  /** Optional file path for persisting user accounts JSON. */
  usersFilePath?: string;
  /** Optional file path for persisting or loading the token signing secret. */
  secretFilePath?: string;
  /** Secret key for HMAC token signing (auto-generated or loaded from secretFilePath if omitted). */
  tokenSecret?: string;
}

/**
 * Manages user account registration, password hashing (scrypt with unique salts),
 * credential authentication, and HMAC-signed session tokens.
 */
export class AuthManager {
  private users: Map<string, UserAccount> = new Map(); // username -> UserAccount
  private usersById: Map<string, UserAccount> = new Map(); // id -> UserAccount
  private usersFilePath?: string;
  private secretFilePath?: string;
  private customTokenSecretProvided: boolean;
  private tokenSecret: string;
  private isLoaded = false;

  /**
   * Initializes a new AuthManager instance.
   *
   * @param options - Configuration options for user persistence and token signing.
   */
  constructor(options: AuthManagerOptions = {}) {
    this.usersFilePath = options.usersFilePath
      ? path.resolve(options.usersFilePath)
      : undefined;
    this.secretFilePath = options.secretFilePath
      ? path.resolve(options.secretFilePath)
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

    this.tokenSecret =
      secret ??
      `tetherdb-default-secret-${crypto.randomBytes(16).toString('hex')}`;

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
        // file doesn't exist yet
      }
    }
    this.isLoaded = true;
  }

  private async persist(): Promise<void> {
    if (!this.usersFilePath) return;
    const dir = path.dirname(this.usersFilePath);
    await fs.mkdir(dir, { recursive: true });
    const list = Array.from(this.users.values());
    await fs.writeFile(
      this.usersFilePath,
      JSON.stringify(list, null, 2),
      'utf-8',
    );
  }

  private hashPassword(password: string, salt: string): string {
    return crypto.scryptSync(password, salt, 32).toString('hex');
  }

  /**
   * Registers a new user account with scrypt password hashing and returns an authentication token.
   *
   * @param username - Desired username (at least 2 characters).
   * @param password - Account password (at least 4 characters).
   * @returns Object containing user metadata and signed session token.
   */
  async register(
    username: string,
    password: string,
  ): Promise<{ user: { id: string; username: string }; token: string }> {
    await this.init();
    const cleanUsername = validateUsername(username);

    const key = cleanUsername.toLowerCase().trim();
    if (this.users.has(key)) {
      throw new Error('Username already exists');
    }

    if (
      typeof password !== 'string' ||
      password.length < 4 ||
      password.length > 1024
    ) {
      throw new Error('Password must be between 4 and 1024 characters long');
    }

    const id = crypto.randomUUID();
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = this.hashPassword(password, salt);

    const now = Date.now();
    const account: UserAccount = {
      id,
      username: cleanUsername,
      passwordHash,
      salt,
      createdAt: now,
      lastLoginAt: now,
    };

    this.users.set(key, account);
    this.usersById.set(id, account);
    await this.persist();

    const token = this.generateToken(account.id, account.username);
    return {
      user: { id: account.id, username: account.username },
      token,
    };
  }

  /**
   * Authenticates user credentials and returns a signed session token.
   * Updates the user's `lastLoginAt` timestamp upon successful authentication.
   *
   * @param username - Account username.
   * @param password - Account password.
   * @returns Object containing user metadata and signed session token.
   */
  async login(
    username: string,
    password: string,
  ): Promise<{ user: { id: string; username: string }; token: string }> {
    await this.init();
    const cleanUsername = validateUsername(username);
    if (typeof password !== 'string' || password.length === 0) {
      throw new Error('Invalid username or password');
    }

    const key = cleanUsername.toLowerCase().trim();
    const account = this.users.get(key);
    if (!account) {
      throw new Error('Invalid username or password');
    }

    const hash = this.hashPassword(password, account.salt);
    if (hash !== account.passwordHash) {
      throw new Error('Invalid username or password');
    }

    account.lastLoginAt = Date.now();
    await this.persist();

    const token = this.generateToken(account.id, account.username);
    return {
      user: { id: account.id, username: account.username },
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
    const payload = JSON.stringify({
      userId,
      username,
      iat: Date.now(),
    });
    const encodedPayload = Buffer.from(payload).toString('base64url');
    const signature = crypto
      .createHmac('sha256', this.tokenSecret)
      .update(encodedPayload)
      .digest('base64url');
    return `${encodedPayload}.${signature}`;
  }

  /**
   * Verifies an HMAC-signed authentication session token and returns the decoded session payload.
   *
   * @param token - Base64url-encoded signed session token.
   * @returns The decoded `AuthSession` object, or `null` if the token is invalid, tampered with, or expired.
   */
  verifyToken(token: string): AuthSession | null {
    if (typeof token !== 'string' || !token.includes('.')) {
      return null;
    }

    const [encodedPayload, signature] = token.split('.');
    if (!encodedPayload || !signature) {
      return null;
    }

    const expectedSig = crypto
      .createHmac('sha256', this.tokenSecret)
      .update(encodedPayload)
      .digest('base64url');

    if (signature !== expectedSig) {
      return null;
    }

    try {
      const decoded = Buffer.from(encodedPayload, 'base64url').toString(
        'utf-8',
      );
      const payload: { userId?: unknown; username?: unknown } =
        JSON.parse(decoded);
      if (
        typeof payload.userId !== 'string' ||
        typeof payload.username !== 'string'
      ) {
        return null;
      }
      return {
        userId: payload.userId,
        username: payload.username,
      };
    } catch {
      return null;
    }
  }

  /**
   * Resolves a user account by unique user ID.
   *
   * @param id - User identifier.
   * @returns UserAccount if found, or `undefined`.
   */
  getUserById(id: string): UserAccount | undefined {
    return this.usersById.get(id);
  }

  /**
   * Resolves a user account by username.
   *
   * @param username - User account username.
   * @returns UserAccount if found, or `undefined`.
   */
  getUserByUsername(username: string): UserAccount | undefined {
    const clean = username.toLowerCase().trim();
    return this.users.get(clean);
  }
}
