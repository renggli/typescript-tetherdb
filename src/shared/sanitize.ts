/**
 * Security, input validation, and sanitization utilities.
 * Protects server-side storage and synchronization from injection and traversal attacks.
 * Formats errors with exact user and table context for precise debugging and monitoring.
 *
 * @module tetherdb/shared/sanitize
 */

/**
 * Regex for strictly valid alphanumeric/hyphen/underscore identifiers (e.g. user IDs, batch IDs, client IDs).
 */
const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z0-9_-]{2,128}$/;

/**
 * Regex for valid table/store names (alphanumeric, underscores, hyphens).
 */
const SAFE_STORE_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Regex for valid usernames (alphanumeric, underscores, hyphens, and dots).
 */
const SAFE_USERNAME_REGEX = /^[a-zA-Z0-9_.-]{2,64}$/;

/**
 * Regex for valid application namespace identifiers (alphanumeric, underscores, hyphens, and dots).
 */
const SAFE_APP_ID_REGEX = /^[a-zA-Z0-9_.-]{1,64}$/;

/**
 * Reserved keywords and prototype properties that must never be used as store or metadata keys.
 */
const RESERVED_STORE_NAMES: ReadonlySet<string> = new Set([
  '__proto__',
  'prototype',
  'constructor',
  'meta',
  'changelog',
  'users',
  'secret',
  'con',
  'prn',
  'aux',
  'nul',
]);

/**
 * Validates a user ID string ensuring it is alphanumeric with hyphens/underscores and safe for file paths.
 *
 * @param userId - The user ID to validate.
 * @returns The validated user ID.
 * @throws Error if the user ID is invalid or contains unsafe characters.
 */
export function validateUserId(userId: string): string {
  if (typeof userId !== 'string' || !SAFE_IDENTIFIER_REGEX.test(userId)) {
    throw new Error(
      `Invalid user ID: "${userId}". User IDs must be 2-128 alphanumeric characters, hyphens, or underscores.`,
    );
  }
  return userId;
}

/**
 * Validates an application namespace identifier. Defaults to 'default' if omitted.
 *
 * @param appId - The application ID to validate.
 * @returns The validated application ID.
 * @throws Error if the application ID is invalid or reserved.
 */
export function validateAppId(appId?: string): string {
  const normalized = appId ? appId.trim() : 'default';
  if (!SAFE_APP_ID_REGEX.test(normalized)) {
    throw new Error(
      `Invalid application ID: "${appId}". Application IDs must be 1-64 alphanumeric characters, hyphens, underscores, or dots.`,
    );
  }
  const lower = normalized.toLowerCase();
  if (
    lower === '__proto__' ||
    lower === 'prototype' ||
    lower === 'constructor' ||
    lower === 'users' ||
    lower === 'secret'
  ) {
    throw new Error(`Application ID "${appId}" is a reserved keyword.`);
  }
  return normalized;
}

/**
 * Validates a store/table name ensuring it is safe from path traversal and not reserved.
 * Includes user context in errors when provided.
 *
 * @param storeName - The table/store name to validate.
 * @param allowedStores - Optional allowlist of permitted table names.
 * @param userId - Optional target user ID for contextual error reporting.
 * @returns The validated store name.
 * @throws Error if the store name is invalid, reserved, or not in the allowlist.
 */
export function validateStoreName(
  storeName: string,
  allowedStores?: ReadonlySet<string> | readonly string[],
  userId?: string,
): string {
  const userSuffix = userId ? ` for user "${userId}"` : '';

  if (typeof storeName !== 'string' || !SAFE_STORE_REGEX.test(storeName)) {
    throw new Error(
      `Invalid table name: "${storeName}"${userSuffix}. Table names must be 1-64 alphanumeric characters, hyphens, or underscores.`,
    );
  }

  const normalized = storeName.toLowerCase();
  if (RESERVED_STORE_NAMES.has(normalized)) {
    throw new Error(
      `Table name "${storeName}" is a reserved system keyword and cannot be used${userSuffix}.`,
    );
  }

  if (allowedStores !== undefined) {
    const isAllowed = Array.isArray(allowedStores)
      ? allowedStores.includes(storeName)
      : allowedStores instanceof Set
        ? allowedStores.has(storeName)
        : (allowedStores as ReadonlySet<string>).has(storeName);
    if (!isAllowed) {
      throw new Error(
        `Table "${storeName}" is not in the allowed tables list${userSuffix}.`,
      );
    }
  }

  return storeName;
}

/**
 * Validates a record ID ensuring it is a non-empty string within size limits and contains no null bytes.
 * Includes table and user context in errors when provided.
 *
 * @param id - The record identifier to validate.
 * @param storeName - Optional table name context.
 * @param userId - Optional user ID context.
 * @returns The validated record ID.
 * @throws Error if the record ID is invalid or exceeds max length.
 */
export function validateRecordId(
  id: string,
  storeName?: string,
  userId?: string,
): string {
  const contextParts: string[] = [];
  if (storeName) contextParts.push(`table: "${storeName}"`);
  if (userId) contextParts.push(`user: "${userId}"`);
  const contextSuffix =
    contextParts.length > 0 ? ` (${contextParts.join(', ')})` : '';

  if (typeof id !== 'string' || id.length === 0 || id.length > 512) {
    throw new Error(
      `Invalid record ID: Record IDs must be non-empty strings up to 512 characters${contextSuffix}.`,
    );
  }
  if (id.includes('\0') || id === '__proto__' || id === 'prototype') {
    throw new Error(
      `Invalid record ID "${id}": Contains forbidden characters or keys${contextSuffix}.`,
    );
  }
  return id;
}

/** Minimum allowed username character length. */
export const MIN_USERNAME_LENGTH = 2;

/** Maximum allowed username character length. */
export const MAX_USERNAME_LENGTH = 64;

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
 *
 * @param username - The username to validate.
 * @returns The validated and normalized username (trimmed and lowercase).
 * @throws Error if the username is invalid, out of length bounds, or contains forbidden characters.
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
  if (!SAFE_USERNAME_REGEX.test(normalized)) {
    throw new Error(
      `Invalid username: "${username}". Usernames must contain only alphanumeric characters, hyphens, underscores, or dots.`,
    );
  }
  if (
    normalized === '__proto__' ||
    normalized === 'prototype' ||
    normalized === 'constructor'
  ) {
    throw new Error(`Username "${username}" is a reserved keyword.`);
  }
  return normalized;
}

/**
 * Validates a client correlation or batch ID.
 *
 * @param id - The batch or client identifier.
 * @param name - Identifier type description (e.g. 'batchId', 'clientId').
 * @param userId - Optional user context.
 * @returns The validated ID.
 */
export function validateIdentifier(
  id: string,
  name = 'Identifier',
  userId?: string,
): string {
  const userSuffix = userId ? ` for user "${userId}"` : '';
  if (typeof id !== 'string' || !SAFE_IDENTIFIER_REGEX.test(id)) {
    throw new Error(
      `Invalid ${name}: "${id}"${userSuffix}. Must be 2-128 alphanumeric characters, hyphens, or underscores.`,
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
