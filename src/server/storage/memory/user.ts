import { TetherServerError, TetherServerErrorCode } from '../../errors.js';
import {
  hashUserPassword,
  UserBaseStorage,
  verifyUserPassword,
} from '../base/index.js';
import type { MemoryStorage } from './storage.js';

export interface MemoryUserData {
  userId: string;
  userName: string;
  passwordHash: string | null;
  createdAt: number;
}

/**
 * In-memory implementation of `UserStorage`.
 */
export class UserMemoryStorage extends UserBaseStorage<MemoryStorage> {
  constructor(data: MemoryUserData, storage: MemoryStorage) {
    super(data.userId, data.userName, data.createdAt, storage);
  }

  private getUserData(): MemoryUserData {
    const data = this.storage.getUserData(this.userId);
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
}
