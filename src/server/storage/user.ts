/**
 * User storage handle managing account identity, credentials, tokens, and data lifecycles.
 */
export interface UserStorage {
  /** Unique user account identifier. */
  readonly id: string;
  /** Normalized username. */
  readonly username: string;
  /** Epoch timestamp when the user account was created. */
  readonly createdAt: number;

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
   * Deletes this user account and all of their data across all applications.
   *
   * @returns True if deleted successfully.
   */
  delete(): Promise<boolean>;
}
