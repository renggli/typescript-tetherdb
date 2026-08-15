import {
  createSessionToken,
  hashPassword,
  verifyPasswordHash,
  verifySessionToken,
} from '../../crypto.js';
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
    const data = this.storage.rawUsers.get(this.id);
    if (!data) throw new Error(`User "${this.id}" not found.`);
    return data;
  }

  async verifyPassword(password: string): Promise<boolean> {
    const data = this.getUserData();
    if (!data.passwordHash) return false;
    return verifyPasswordHash(password, data.passwordHash);
  }

  async changePassword(newPassword: string): Promise<void> {
    const data = this.getUserData();
    data.passwordHash = await hashPassword(newPassword);
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
