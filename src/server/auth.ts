import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

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
  /** Secret key for HMAC token signing (auto-generated if omitted). */
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
    this.tokenSecret =
      options.tokenSecret ??
      `beameddb-default-secret-${crypto.randomBytes(16).toString('hex')}`;
  }

  /**
   * Loads persisted user accounts from disk if a usersFilePath was configured.
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
    const cleanUsername = username.trim();
    if (!cleanUsername || cleanUsername.length < 2) {
      throw new Error('Username must be at least 2 characters long');
    }
    if (!password || password.length < 4) {
      throw new Error('Password must be at least 4 characters long');
    }

    const key = cleanUsername.toLowerCase();
    if (this.users.has(key)) {
      throw new Error('Username already exists');
    }

    const id = `usr_${crypto.randomUUID().replace(/-/g, '').substring(0, 16)}`;
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = this.hashPassword(password, salt);

    const account: UserAccount = {
      id,
      username: cleanUsername,
      passwordHash,
      salt,
      createdAt: Date.now(),
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
    const key = username.trim().toLowerCase();
    const account = this.users.get(key);
    if (!account) {
      throw new Error('Invalid username or password');
    }

    const hash = this.hashPassword(password, account.salt);
    if (hash !== account.passwordHash) {
      throw new Error('Invalid username or password');
    }

    const token = this.generateToken(account.id, account.username);
    return {
      user: { id: account.id, username: account.username },
      token,
    };
  }

  /**
   * Generates an HMAC-signed session token for a given user.
   *
   * @param userId - Target user identifier.
   * @param username - Target username.
   * @returns Signed URL-safe token string.
   */
  generateToken(userId: string, username: string): string {
    const payload = JSON.stringify({
      userId,
      username,
      exp: Date.now() + 1000 * 60 * 60 * 24 * 30,
    });
    const payloadB64 = Buffer.from(payload).toString('base64url');
    const sig = crypto
      .createHmac('sha256', this.tokenSecret)
      .update(payloadB64)
      .digest('base64url');
    return `${payloadB64}.${sig}`;
  }

  /**
   * Verifies an HMAC-signed session token and checks expiration.
   *
   * @param token - Token string to verify.
   * @returns The decoded `AuthSession` if valid and unexpired; otherwise `null`.
   */
  verifyToken(token: string): AuthSession | null {
    try {
      const parts = token.split('.');
      if (parts.length !== 2) return null;
      const [payloadB64, sig] = parts;
      const expectedSig = crypto
        .createHmac('sha256', this.tokenSecret)
        .update(payloadB64)
        .digest('base64url');

      if (sig !== expectedSig) return null;

      const payload = JSON.parse(
        Buffer.from(payloadB64, 'base64url').toString('utf-8'),
      );
      if (payload.exp && Date.now() > payload.exp) {
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
}
