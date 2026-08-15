/**
 * Security, input validation, and sanitization utilities for the TetherDB server.
 * Protects server-side storage and synchronization from injection and traversal attacks.
 *
 * @module tetherdb/server/validate
 */

/**
 * Validates that an identifier is safe for filesystem use (1-64 alphanumeric, hyphens, or underscores).
 *
 * @param id - The identifier string to validate.
 * @param name - The human-readable name of the identifier type.
 * @returns The validated identifier.
 */
function validateFilesystemSafe(id: string, name: string): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw new Error(
      `Invalid ${name}: "${id}". ${name}s must be 1-64 alphanumeric characters, hyphens, or underscores.`,
    );
  }
  return id;
}

/**
 * Validates a user ID string ensuring it is safe for filesystem use.
 *
 * @param userId - The user ID to validate.
 * @returns The validated user ID.
 * @throws Error if the user ID is invalid or contains unsafe characters.
 */
export function validateUserId(userId: string): string {
  return validateFilesystemSafe(userId, 'user ID');
}

/**
 * Validates an application namespace identifier.
 *
 * @param appId - The application ID to validate.
 * @returns The validated application ID.
 * @throws Error if the application ID is invalid.
 */
export function validateAppId(appId: string): string {
  return validateFilesystemSafe(appId, 'application ID');
}

/**
 * Validates a table name ensuring it is safe for filesystem use.
 *
 * @param tableName - The table name to validate.
 * @returns The validated table name.
 * @throws Error if the table name is invalid.
 */
export function validateTableName(tableName: string): string {
  return validateFilesystemSafe(tableName, 'table name');
}

/**
 * Validates a record ID ensuring it is a non-empty string within size limits.
 *
 * @param id - The record identifier to validate.
 * @returns The validated record ID.
 * @throws Error if the record ID is invalid or exceeds max length.
 */
export function validateRecordId(id: string): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 512) {
    throw new Error(
      'Invalid record ID: Record IDs must be non-empty strings up to 512 characters.',
    );
  }
  return id;
}

/** Minimum allowed username character length. */
export const MIN_USERNAME_LENGTH = 4;

/** Maximum allowed username character length. */
export const MAX_USERNAME_LENGTH = 128;

/**
 * Normalizes a username by trimming whitespace and converting to lowercase.
 *
 * @param username - The raw username string.
 * @returns The normalized username (lowercase and trimmed).
 */
export function normalizeUsername(username: string): string {
  return typeof username === 'string' ? username.trim().toLowerCase() : '';
}

/**
 * Validates and normalizes a username for account creation or authentication.
 * Usernames must be between 4 and 128 characters long.
 *
 * @param username - The username to validate.
 * @returns The validated and normalized username (trimmed and lowercase).
 * @throws Error if the username is invalid or out of length bounds.
 */
export function validateUsername(username: string): string {
  if (typeof username !== 'string') {
    throw new Error(
      `Username must be a string between ${MIN_USERNAME_LENGTH} and ${MAX_USERNAME_LENGTH} characters long.`,
    );
  }
  const normalized = normalizeUsername(username);
  if (
    normalized.length < MIN_USERNAME_LENGTH ||
    normalized.length > MAX_USERNAME_LENGTH
  ) {
    throw new Error(
      `Username must be between ${MIN_USERNAME_LENGTH} and ${MAX_USERNAME_LENGTH} characters long.`,
    );
  }
  return normalized;
}

/** Minimum allowed password character length. */
export const MIN_PASSWORD_LENGTH = 4;

/** Maximum allowed password character length. */
export const MAX_PASSWORD_LENGTH = 512;

/**
 * Normalizes a password by trimming surrounding whitespace.
 *
 * @param password - The raw password string.
 * @returns The normalized password (trimmed).
 */
export function normalizePassword(password: string): string {
  return typeof password === 'string' ? password.trim() : '';
}

/**
 * Validates a password for user account creation or authentication.
 *
 * @param password - The password string to validate.
 * @returns The validated password.
 * @throws Error if the password is not a string, is empty, or exceeds length bounds.
 */
export function validatePassword(password: string): string {
  if (typeof password !== 'string') {
    throw new Error('Password must be a valid non-empty string.');
  }
  const normalized = normalizePassword(password);
  if (
    normalized.length < MIN_PASSWORD_LENGTH ||
    normalized.length > MAX_PASSWORD_LENGTH
  ) {
    throw new Error(
      `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters long.`,
    );
  }
  return normalized;
}

/**
 * Validates a client correlation or batch ID.
 *
 * @param id - The batch or client identifier.
 * @param name - Identifier type description (e.g. 'batchId', 'clientId').
 * @returns The validated ID.
 */
export function validateIdentifier(id: string, name = 'Identifier'): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{2,128}$/.test(id)) {
    throw new Error(
      `Invalid ${name}: "${id}". Must be 2-128 alphanumeric characters, hyphens, or underscores.`,
    );
  }
  return id;
}

/**
 * Estimates the byte size of an arbitrary JavaScript value or object when serialized.
 *
 * @param value - The value to measure.
 * @returns Size in bytes.
 */
export function calculateByteSize(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf-8');
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 4;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf-8');
  } catch {
    return 0;
  }
}
