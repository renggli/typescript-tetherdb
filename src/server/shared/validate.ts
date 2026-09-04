/**
 * Security, input validation, and sanitization utilities for the TetherDB server.
 * Protects server-side storage and synchronization from injection and traversal attacks.
 *
 * @module tetherdb/server/shared/validate
 */

import { isValidTableName } from '../../shared/validate.js';
import { TetherServerError, TetherServerErrorCode } from '../errors.js';

/** Minimum allowed username character length. */
export const MIN_USER_NAME_LENGTH = 3;

/** Maximum allowed username character length. */
export const MAX_USER_NAME_LENGTH = 128;

/** Minimum allowed password character length. */
export const MIN_PASSWORD_LENGTH = 4;

/** Maximum allowed password character length. */
export const MAX_PASSWORD_LENGTH = 512;

/** Maximum allowable future timestamp drift in milliseconds (5 minutes). */
const MAX_FUTURE_TIMESTAMP_DRIFT_MS = 5 * 60 * 1000;

/**
 * Validates a change timestamp, ensuring it is a valid finite epoch number
 * and does not exceed the maximum allowable future drift.
 *
 * @param timestamp - The epoch timestamp in milliseconds.
 * @param maxFutureDriftMs - Optional maximum allowable future drift in ms (defaults to 5 minutes).
 * @returns The validated timestamp.
 * @throws TetherServerError if timestamp is not finite, is non-positive, or exceeds drift bounds.
 */
export function validateTimestamp(
  timestamp: number,
  maxFutureDriftMs = MAX_FUTURE_TIMESTAMP_DRIFT_MS,
): number {
  if (
    typeof timestamp !== 'number' ||
    !Number.isFinite(timestamp) ||
    timestamp <= 0
  ) {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      'Invalid timestamp',
    );
  }
  if (timestamp > Date.now() + maxFutureDriftMs) {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      'Timestamp drift exceeds maximum allowable threshold',
    );
  }
  return timestamp;
}

/**
 * Validates a user ID string ensuring it is safe for filesystem use.
 *
 * @param userId - The user ID to validate.
 * @returns The validated user ID.
 * @throws TetherServerError if user ID is empty, too long, or contains invalid characters.
 */
export function validateUserId(userId: string): string {
  return validateFilesystemSafe(userId, 'user ID');
}

/**
 * Validates an application or table identifier, ensuring safety against path traversal.
 *
 * @param name - The table identifier.
 * @returns The validated table name.
 * @throws TetherServerError if the name is invalid or unsafe.
 */
export function validateTableName(name: string): string {
  if (!isValidTableName(name)) {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      'Invalid table name',
    );
  }
  return name;
}

/**
 * Validates a client device or session identifier.
 *
 * @param clientId - The client UUID or identifier.
 * @returns The validated client ID.
 * @throws TetherServerError if the client ID contains invalid characters.
 */
export function validateClientId(clientId: string): string {
  return validateFilesystemSafe(clientId, 'client ID');
}

/**
 * Validates a record primary key identifier.
 *
 * @param id - The record primary key.
 * @returns The validated record ID.
 * @throws TetherServerError if the ID is empty, too long, or contains invalid characters.
 */
export function validateRecordId(id: string): string {
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    id.length > 256 ||
    id.includes('\0')
  ) {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      'Invalid record ID',
    );
  }
  return id;
}

/**
 * Normalizes a username by trimming whitespace and converting to lowercase.
 *
 * @param userName - The raw username string.
 * @returns The normalized username (lowercase and trimmed).
 */
export function normalizeUserName(userName: string): string {
  return typeof userName === 'string' ? userName.trim().toLowerCase() : '';
}

/**
 * Validates and normalizes a username for account creation or authentication.
 * Usernames must be between 3 and 128 characters long.
 *
 * @param userName - The username to validate.
 * @returns The validated and normalized username (trimmed and lowercase).
 * @throws TetherServerError if the username is invalid or out of length bounds.
 */
export function validateUserName(userName: string): string {
  const normalized = normalizeUserName(userName);
  if (
    normalized.length < MIN_USER_NAME_LENGTH ||
    normalized.length > MAX_USER_NAME_LENGTH
  ) {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      `Username must be between ${MIN_USER_NAME_LENGTH} and ${MAX_USER_NAME_LENGTH} characters`,
    );
  }
  return normalized;
}

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
 * @throws TetherServerError if the password is not a string, is empty, or exceeds length bounds.
 */
export function validatePassword(password: string): string {
  const normalized = normalizePassword(password);
  if (
    normalized.length < MIN_PASSWORD_LENGTH ||
    normalized.length > MAX_PASSWORD_LENGTH
  ) {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters`,
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
 * @throws TetherServerError if the identifier format is invalid.
 */
export function validateIdentifier(id: string, name = 'identifier'): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{2,128}$/.test(id)) {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      `Invalid ${name}`,
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

/**
 * Calculates a 2-character hex/hash bucket for directory partitioning by user ID.
 *
 * @param userId - Unique user identifier.
 * @returns 2-character bucket string (e.g. 'f4', '0a').
 */
export function getUserBucket(userId: string): string {
  const safeId = validateUserId(userId);
  const clean = safeId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return clean.length >= 2 ? clean.slice(0, 2) : clean.padStart(2, '0');
}

/**
 * Validates changelog retention count for maintenance prune operations.
 *
 * @param keepCount - Optional retention count.
 * @param defaultKeep - Fallback default retention count (defaults to 1000).
 * @returns Validated non-negative integer count.
 * @throws TetherServerError if keepCount is negative, non-finite, or invalid.
 */
export function validateKeepCount(
  keepCount: unknown,
  defaultKeep = 1000,
): number {
  if (keepCount === undefined || keepCount === null) {
    return defaultKeep;
  }
  if (
    typeof keepCount !== 'number' ||
    !Number.isFinite(keepCount) ||
    !Number.isInteger(keepCount) ||
    keepCount < 0
  ) {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      'Prune keepCount must be a non-negative integer',
    );
  }
  return keepCount;
}

// -- Private Helpers --------------------------------------------------------

function validateFilesystemSafe(id: string, name: string): string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw new TetherServerError(
      TetherServerErrorCode.InvalidInput,
      `Invalid ${name}`,
    );
  }
  return id;
}
