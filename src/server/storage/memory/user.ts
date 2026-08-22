import { TetherServerError, TetherServerErrorCode } from '../../errors.js';
import {
  hashUserPassword,
  UserBaseStorage,
  verifyUserPassword,
} from '../base/index.js';
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
export class UserMemoryStorage extends UserBaseStorage {
  private storage: MemoryStorage;

  constructor(data: MemoryUserData, storage: MemoryStorage) {
    super(data.id, data.username, data.createdAt);
    this.storage = storage;
  }

  protected getSecret(): string {
    return this.storage.secret;
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
    return verifyUserPassword(password, data.passwordHash);
  }

  async changePassword(newPassword: string): Promise<void> {
    const data = this.getUserData();
    data.passwordHash = await hashUserPassword(newPassword);
  }

  async delete(): Promise<boolean> {
    return this.storage.deleteUser(this.id);
  }
}
