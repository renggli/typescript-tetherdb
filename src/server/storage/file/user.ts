import {
  hashUserPassword,
  UserBaseStorage,
  verifyUserPassword,
} from '../base/index.js';
import type { FileStorage, FileUserData } from './storage.js';

/**
 * Filesystem-backed implementation of `UserStorage`.
 */
export class UserFileStorage extends UserBaseStorage {
  private storage: FileStorage;

  constructor(data: FileUserData, storage: FileStorage) {
    super(data.id, data.username, data.createdAt);
    this.storage = storage;
  }

  protected getSecret(): string {
    return this.storage.secret;
  }

  async verifyPassword(password: string): Promise<boolean> {
    const user = await this.storage.findUserDataById(this.id);
    return verifyUserPassword(password, user?.passwordHash);
  }

  async changePassword(newPassword: string): Promise<void> {
    const newHash = await hashUserPassword(newPassword);
    await this.storage.updateUserData(this.id, { passwordHash: newHash });
  }

  async delete(): Promise<boolean> {
    return this.storage.deleteUser(this.id);
  }
}
