import {
  hashUserPassword,
  UserBaseStorage,
  verifyUserPassword,
} from '../base/index.js';
import type { SqliteStorage, SqliteUserData } from './storage.js';

/**
 * SQLite-backed implementation of `UserStorage`.
 */
export class UserSqliteStorage extends UserBaseStorage<SqliteStorage> {
  constructor(data: SqliteUserData, storage: SqliteStorage) {
    super(data.id, data.username, data.createdAt, storage);
  }

  async verifyPassword(password: string): Promise<boolean> {
    const user = this.storage.findUserDataById(this.id);
    return verifyUserPassword(password, user?.passwordHash);
  }

  async changePassword(newPassword: string): Promise<void> {
    const newHash = await hashUserPassword(newPassword);
    this.storage.updateUserData(this.id, newHash);
  }
}
