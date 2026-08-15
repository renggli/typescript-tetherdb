import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
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

const require = createRequire(import.meta.url);
const { DatabaseSync: NodeDatabaseSync } = require('node:sqlite') as {
  DatabaseSync: typeof DatabaseSync;
};

/**
 * Options for configuring the SQLite authentication adapter.
 */
export interface SqliteAuthOptions {
  /** Directory path where 'auth.sqlite' database is stored. Defaults to '.data'. */
  baseDir?: string;
  /** Explicit path to SQLite file or ':memory:'. Overrides baseDir. */
  filename?: string;
  /** Whether to run purely in memory (:memory:). */
  inMemory?: boolean;
  /** Secret key for HMAC token signing (auto-generated or loaded from database if omitted). */
  tokenSecret?: string;
}

interface RawUserRow {
  id: string;
  username: string;
  password_hash: string;
  salt: string;
  created_at: number;
  last_login_at: number;
}

/**
 * SQLite implementation of `AuthAdapter`.
 * Stores user accounts and token secrets in `<baseDir>/auth.sqlite` (or in-memory).
 * Provides ACID-compliant user registration, authentication, credential verification,
 * and persistent session token signing secrets.
 */
export class SqliteAuthAdapter implements AuthAdapter {
  private db: DatabaseSync;
  private filePath: string;
  private tokenSecret: string;

  private stmtGetUserById: StatementSync;
  private stmtGetUserByUsername: StatementSync;
  private stmtInsertUser: StatementSync;
  private stmtUpdateLastLogin: StatementSync;
  private stmtClearUsers: StatementSync;

  /**
   * Initializes a new SqliteAuthAdapter instance.
   *
   * @param options - SQLite authentication configuration options.
   */
  constructor(options: SqliteAuthOptions = {}) {
    const isMemory =
      options.inMemory ||
      options.filename === ':memory:' ||
      options.baseDir === ':memory:';

    if (isMemory) {
      this.filePath = ':memory:';
    } else if (options.filename) {
      this.filePath = path.resolve(options.filename);
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    } else {
      const base = path.resolve(options.baseDir ?? '.data');
      fs.mkdirSync(base, { recursive: true });
      this.filePath = path.join(base, 'auth.sqlite');
    }

    this.db = new NodeDatabaseSync(this.filePath);

    if (this.filePath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    }
    this.db.exec('PRAGMA foreign_keys = ON;');

    this.initSchema();

    // Initialize or load token secret from database
    let secret = options.tokenSecret;
    if (!secret) {
      const stmtGetMeta = this.db.prepare(
        "SELECT value FROM auth_meta WHERE key = 'token_secret'",
      );
      const row = stmtGetMeta.get() as { value: string } | undefined;
      if (row?.value) {
        secret = row.value;
      } else {
        secret = generateTokenSecret('tetherdb-sqlite-auth');
        const stmtSetMeta = this.db.prepare(
          "INSERT OR REPLACE INTO auth_meta (key, value) VALUES ('token_secret', ?)",
        );
        stmtSetMeta.run(secret);
      }
    }
    this.tokenSecret = secret;

    // Prepare reusable statements
    this.stmtGetUserById = this.db.prepare(
      'SELECT id, username, password_hash, salt, created_at, last_login_at FROM users WHERE id = ?',
    );
    this.stmtGetUserByUsername = this.db.prepare(
      'SELECT id, username, password_hash, salt, created_at, last_login_at FROM users WHERE username = ?',
    );
    this.stmtInsertUser = this.db.prepare(
      'INSERT INTO users (id, username, password_hash, salt, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    this.stmtUpdateLastLogin = this.db.prepare(
      'UPDATE users SET last_login_at = ? WHERE id = ?',
    );
    this.stmtClearUsers = this.db.prepare('DELETE FROM users');
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_login_at INTEGER NOT NULL
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
        ON users (username);

      CREATE TABLE IF NOT EXISTS auth_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private mapUser(row: RawUserRow): UserAccount {
    return {
      id: row.id,
      username: row.username,
      passwordHash: row.password_hash,
      salt: row.salt,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
    };
  }

  /**
   * Registers a new user account with scrypt password hashing and returns an authentication token.
   *
   * @param username - Desired username.
   * @param password - Account password.
   * @returns A promise resolving to the authenticated session with signed token.
   */
  async register(username: string, password: string): Promise<AuthToken> {
    const cleanUsername = validateUsername(username);

    const existing = this.stmtGetUserByUsername.get(cleanUsername) as
      | RawUserRow
      | undefined;
    if (existing) {
      throw new Error('Username already exists');
    }

    const account = createUserAccount(cleanUsername, password);

    this.stmtInsertUser.run(
      account.id,
      account.username,
      account.passwordHash,
      account.salt,
      account.createdAt,
      account.lastLoginAt ?? 0,
    );

    const token = this.generateToken(account.id, account.username);
    return {
      userId: account.id,
      username: account.username,
      token,
    };
  }

  /**
   * Authenticates user credentials and returns a signed session token.
   * Updates the user's `lastLoginAt` timestamp in the database upon success.
   *
   * @param username - Account username.
   * @param password - Account password.
   * @returns A promise resolving to the authenticated session with signed token.
   */
  async login(username: string, password: string): Promise<AuthToken> {
    const cleanUsername = validateUsername(username);
    const row = this.stmtGetUserByUsername.get(cleanUsername) as
      | RawUserRow
      | undefined;

    if (!row || !verifyPassword(password, row.salt, row.password_hash)) {
      throw new Error('Invalid username or password');
    }

    const now = Date.now();
    this.stmtUpdateLastLogin.run(now, row.id);

    const token = this.generateToken(row.id, row.username);
    return {
      userId: row.id,
      username: row.username,
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
    const row = this.stmtGetUserById.get(id) as RawUserRow | undefined;
    return row ? this.mapUser(row) : undefined;
  }

  /**
   * Resolves a user account by username.
   *
   * @param username - User account username.
   * @returns A promise resolving to the UserAccount if found, or `undefined`.
   */
  async getUserByUsername(username: string): Promise<UserAccount | undefined> {
    const clean = normalizeUsername(username);
    const row = this.stmtGetUserByUsername.get(clean) as RawUserRow | undefined;
    return row ? this.mapUser(row) : undefined;
  }

  /**
   * Clears all stored user accounts from the SQLite database.
   */
  clear(): void {
    this.stmtClearUsers.run();
  }

  /**
   * Closes the underlying SQLite database connection cleanly.
   */
  async close(): Promise<void> {
    this.db.close();
  }
}
