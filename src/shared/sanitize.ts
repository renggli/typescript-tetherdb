/**
 * Security, input validation, and sanitization utilities.
 * Protects server-side storage and synchronization from injection and traversal attacks.
 *
 * @module beameddb/shared/sanitize
 */

/**
 * Regex for strictly valid alphanumeric/hyphen/underscore identifiers (e.g. user IDs, batch IDs, client IDs).
 */
const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z0-9_-]{2,128}$/;

/**
 * Regex for valid table/store names (alphanumeric, underscores, hyphens, and single internal dots).
 */
const SAFE_STORE_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * Regex for valid usernames (alphanumeric, underscores, hyphens, and dots).
 */
const SAFE_USERNAME_REGEX = /^[a-zA-Z0-9_.-]{2,64}$/;

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
 * Validates a store/table name ensuring it is safe from path traversal and not reserved.
 *
 * @param storeName - The table/store name to validate.
 * @param allowedStores - Optional allowlist of permitted table names.
 * @returns The validated store name.
 * @throws Error if the store name is invalid, reserved, or not in the allowlist.
 */
export function validateStoreName(
  storeName: string,
  allowedStores?: ReadonlySet<string> | readonly string[],
): string {
  if (typeof storeName !== 'string' || !SAFE_STORE_REGEX.test(storeName)) {
    throw new Error(
      `Invalid store name: "${storeName}". Store names must be 1-64 alphanumeric characters, hyphens, or underscores.`,
    );
  }

  const normalized = storeName.toLowerCase();
  if (RESERVED_STORE_NAMES.has(normalized)) {
    throw new Error(
      `Store name "${storeName}" is a reserved system keyword and cannot be used.`,
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
        `Store "${storeName}" is not in the allowed stores list.`,
      );
    }
  }

  return storeName;
}

/**
 * Validates a record ID ensuring it is a non-empty string within size limits and contains no null bytes.
 *
 * @param id - The record identifier to validate.
 * @returns The validated record ID.
 * @throws Error if the record ID is invalid or exceeds max length.
 */
export function validateRecordId(id: string): string {
  if (typeof id !== 'string' || id.length === 0 || id.length > 512) {
    throw new Error(
      `Invalid record ID: Record IDs must be non-empty strings up to 512 characters.`,
    );
  }
  if (id.includes('\0') || id === '__proto__' || id === 'prototype') {
    throw new Error(
      `Invalid record ID: Contains forbidden characters or keys.`,
    );
  }
  return id;
}

/**
 * Validates a username for account creation or authentication.
 *
 * @param username - The username to validate.
 * @returns The validated trimmed username.
 * @throws Error if the username is invalid or contains forbidden characters.
 */
export function validateUsername(username: string): string {
  const trimmed = typeof username === 'string' ? username.trim() : '';
  if (!SAFE_USERNAME_REGEX.test(trimmed)) {
    throw new Error(
      `Invalid username: "${username}". Usernames must be 2-64 characters containing letters, numbers, hyphens, underscores, or dots.`,
    );
  }
  const lower = trimmed.toLowerCase();
  if (
    lower === '__proto__' ||
    lower === 'prototype' ||
    lower === 'constructor'
  ) {
    throw new Error(`Username "${username}" is a reserved keyword.`);
  }
  return trimmed;
}

/**
 * Validates a client correlation or batch ID.
 *
 * @param id - The batch or client identifier.
 * @returns The validated ID.
 */
export function validateIdentifier(id: string, name = 'Identifier'): string {
  if (typeof id !== 'string' || !SAFE_IDENTIFIER_REGEX.test(id)) {
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
