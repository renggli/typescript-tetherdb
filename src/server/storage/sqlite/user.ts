import {
  createSessionToken,
  hashPassword,
  verifyPasswordHash,
  verifySessionToken,
} from '../../crypto.js';
import { normalizePassword, validatePassword } from '../../validate.js';
import type { UserStorage } from '../user.js';
import type { SqliteStorage, SqliteUserData } from './storage.js';

/**
 * SQLite-backed implementation of `UserStorage`.
 */
export class UserSqliteStorage implements UserStorage {
  readonly id: string;
  readonly username: string;
  readonly createdAt: number;
  private storage: SqliteStorage;

  constructor(data: SqliteUserData, storage: SqliteStorage) {
    this.id = data.id;
    this.username = data.username;
    this.createdAt = data.createdAt;
    this.storage = storage;
  }

  async verifyPassword(password: string): Promise<boolean> {
    const user = this.storage.findUserDataById(this.id);
    if (!user?.passwordHash) return false;
    const normalized = normalizePassword(password);
    if (!normalized) return false;
    return verifyPasswordHash(normalized, user.passwordHash);
  }

  async changePassword(newPassword: string): Promise<void> {
    const valid = validatePassword(newPassword);
    const newHash = await hashPassword(valid);
    this.storage.updateUserData(this.id, newHash);
  }

  async createToken(expiresInSeconds?: number): Promise<string> {
    return createSessionToken(
      this.id,
      this.username,
      this.storage.secret,
      expiresInSeconds,
    );
  }

  async verifyToken(token: string): Promise<boolean> {
    const payload = verifySessionToken(token, this.storage.secret);
    return payload !== null && payload.userId === this.id;
  }

  async delete(): Promise<boolean> {
    return this.storage.deleteUser(this.id);
  }
}
