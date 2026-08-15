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
 * Authenticated user session with a signed token.
 */
export interface AuthToken extends AuthSession {
  /** Signed session authentication token string. */
  token: string;
}

/**
 * Pluggable server-side authentication abstraction managing user registration,
 * credential verification, session token issuance, and account lookups.
 */
export interface AuthAdapter {
  /**
   * Optional initialization callback for loading persisted accounts or configuring secrets.
   */
  init?(): Promise<void>;

  /**
   * Registers a new user account with secure password hashing and returns an authentication token.
   *
   * @param username - Desired username.
   * @param password - Account password.
   * @returns A promise resolving to the authenticated session with signed token.
   */
  register(username: string, password: string): Promise<AuthToken>;

  /**
   * Authenticates user credentials and returns a signed session token.
   *
   * @param username - Account username.
   * @param password - Account password.
   * @returns A promise resolving to the authenticated session with signed token.
   */
  login(username: string, password: string): Promise<AuthToken>;

  /**
   * Verifies an authentication session token and returns the decoded session payload.
   *
   * @param token - Authentication token string.
   * @returns Decoded `AuthSession` object, or `null` if invalid, expired, or tampered with.
   */
  verifyToken(token: string): Promise<AuthSession | null>;

  /**
   * Resolves a user account by unique user ID.
   *
   * @param id - User identifier.
   * @returns UserAccount if found, or `undefined`.
   */
  getUserById?(id: string): Promise<UserAccount | undefined>;

  /**
   * Resolves a user account by username.
   *
   * @param username - User account username.
   * @returns UserAccount if found, or `undefined`.
   */
  getUserByUsername?(username: string): Promise<UserAccount | undefined>;

  /**
   * Optional cleanup callback invoked when shutting down the server.
   */
  close?(): Promise<void>;
}
