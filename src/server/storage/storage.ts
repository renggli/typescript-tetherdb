import type { AppStorage } from './app.js';
import type { UserStorage } from './user.js';

/**
 * Top-level storage coordinator managing application namespaces and user accounts.
 */
export interface Storage {
  /**
   * Creates/registers a new application namespace.
   *
   * @param id - Unique application identifier.
   * @returns Created AppStorage handle.
   */
  createApp(id: string): Promise<AppStorage>;

  /**
   * Retrieves an application handle if it exists.
   *
   * @param id - Unique application identifier.
   * @returns AppStorage handle or `undefined` if not found.
   */
  getApp(id: string): Promise<AppStorage | undefined>;

  /**
   * Lists all registered application handles.
   *
   * @returns Array of AppStorage handles.
   */
  getApps(): Promise<AppStorage[]>;

  /**
   * Creates a new user account with credentials.
   *
   * @param username - Username for the account.
   * @param password - Optional account password.
   * @returns Created UserStorage handle.
   */
  createUser(username: string, password?: string): Promise<UserStorage>;

  /**
   * Retrieves a user handle by user account ID.
   *
   * @param id - Unique user identifier.
   * @returns UserStorage handle or `undefined` if not found.
   */
  getUser(id: string): Promise<UserStorage | undefined>;

  /**
   * Retrieves a user handle by username.
   *
   * @param username - User account username.
   * @returns UserStorage handle or `undefined` if not found.
   */
  getUserByUsername(username: string): Promise<UserStorage | undefined>;

  /**
   * Retrieves a user handle by validating a session token.
   *
   * @param token - Signed session token.
   * @returns UserStorage handle if token is valid and active, or `undefined`.
   */
  getUserByToken(token: string): Promise<UserStorage | undefined>;

  /**
   * Lists all user accounts.
   *
   * @returns Array of UserStorage handles.
   */
  getUsers(): Promise<UserStorage[]>;

  /**
   * Optional cleanup callback invoked when shutting down the storage engine.
   */
  close?(): Promise<void>;
}
