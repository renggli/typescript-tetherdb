import {
  createSessionToken,
  hashPassword,
  verifyPasswordHash,
  verifySessionToken,
} from '../../crypto.js';
import { normalizePassword, validatePassword } from '../../validate.js';
import type { UserStorage } from '../user.js';
import type { FileStorage, FileUserData } from './storage.js';

/**
 * Filesystem-backed implementation of `UserStorage`.
 */
export class UserFileStorage implements UserStorage {
  readonly id: string;
  readonly username: string;
  readonly createdAt: number;
  private storage: FileStorage;

  constructor(data: FileUserData, storage: FileStorage) {
    this.id = data.id;
    this.username = data.username;
    this.createdAt = data.createdAt;
    this.storage = storage;
  }

  async verifyPassword(password: string): Promise<boolean> {
    const user = await this.storage.findUserDataById(this.id);
    if (!user?.passwordHash) return false;
    const normalized = normalizePassword(password);
    if (!normalized) return false;
    return verifyPasswordHash(normalized, user.passwordHash);
  }

  async changePassword(newPassword: string): Promise<void> {
    const valid = validatePassword(newPassword);
    const newHash = await hashPassword(valid);
    await this.storage.updateUserData(this.id, { passwordHash: newHash });
  }

  async createToken(expiresInSeconds?: number): Promise<string> {
    const secret = await this.storage.getSecret();
    return createSessionToken(this.id, this.username, secret, expiresInSeconds);
  }

  async verifyToken(token: string): Promise<boolean> {
    const secret = await this.storage.getSecret();
    const payload = verifySessionToken(token, secret);
    return payload !== null && payload.userId === this.id;
  }

  async delete(): Promise<boolean> {
    return this.storage.deleteUser(this.id);
  }
}
