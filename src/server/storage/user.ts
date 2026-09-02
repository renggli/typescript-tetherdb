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
 * Concrete User domain object managing credentials, session tokens, and deletion.
 */
export class User {
  readonly userId: string;
  readonly userName: string;
  readonly createdAt: number;
  private readonly storage: Storage;

  /**
   * Initializes a new User instance.
   *
   * @param userId - Unique user identifier.
   * @param userName - Normalized username.
   * @param createdAt - Epoch creation timestamp.
   * @param storage - Underlying storage backend.
   */
  constructor(
    userId: string,
    userName: string,
    createdAt: number,
    storage: Storage,
  ) {
    this.userId = userId;
    this.userName = userName;
    this.createdAt = createdAt;
    this.storage = storage;
  }

  /**
   * Verifies if the provided plaintext password matches the stored credentials.
   *
   * @param password - Plaintext password to verify.
   * @returns True if password matches.
   */
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

  /**
   * Changes the user's password.
   *
   * @param newPassword - New plaintext password.
   */
  async changePassword(newPassword: string): Promise<void> {
    const valid = validatePassword(newPassword);
    const newHash = await hashPassword(valid);
    await this.storage.setUserPasswordHash(this.userId, newHash);
  }

  /**
   * Creates a signed session token for this user.
   *
   * @param expiresInSeconds - Optional duration before token expires.
   * @returns Signed token string.
   */
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

  /**
   * Verifies if a session token is valid for this user.
   *
   * @param token - Token string to verify.
   * @returns True if valid and not expired.
   */
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

  /**
   * Deletes this user account and all of their data.
   *
   * @returns True if deleted successfully.
   */
  async delete(): Promise<boolean> {
    return this.storage.deleteUser(this.userId);
  }
}
