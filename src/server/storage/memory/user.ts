import {
  createSessionToken,
  hashPassword,
  verifyPasswordHash,
  verifySessionToken,
} from '../../crypto.js';
import { TetherServerError, TetherServerErrorCode } from '../../errors.js';
import { normalizePassword, validatePassword } from '../../validate.js';
import type { UserStorage } from '../user.js';
import type { MemoryStorage } from './storage.js';

export interface MemoryUserData {
  id: string;
  username: string;
  passwordHash: string | null;
  createdAt: number;
}

/**
 * In-memory implementation of `UserStorage`.
 */
export class UserMemoryStorage implements UserStorage {
  readonly id: string;
  readonly username: string;
  readonly createdAt: number;
  private storage: MemoryStorage;

  constructor(data: MemoryUserData, storage: MemoryStorage) {
    this.id = data.id;
    this.username = data.username;
    this.createdAt = data.createdAt;
    this.storage = storage;
  }

  private getUserData(): MemoryUserData {
    const data = this.storage.getUserData(this.id);
    if (!data) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        'User not found',
      );
    }
    return data;
  }

  async verifyPassword(password: string): Promise<boolean> {
    const data = this.getUserData();
    if (!data.passwordHash) return false;
    const normalized = normalizePassword(password);
    if (!normalized) return false;
    return verifyPasswordHash(normalized, data.passwordHash);
  }

  async changePassword(newPassword: string): Promise<void> {
    const data = this.getUserData();
    const valid = validatePassword(newPassword);
    data.passwordHash = await hashPassword(valid);
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
