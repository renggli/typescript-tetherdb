import * as crypto from 'node:crypto';
import {
  MAX_USERNAME_LENGTH,
  MIN_USERNAME_LENGTH,
  normalizeUsername,
  validateUsername,
} from '../../shared/sanitize.js';
import type { AuthSession, UserAccount } from './adapter.js';

export {
  MAX_USERNAME_LENGTH,
  MIN_USERNAME_LENGTH,
  normalizeUsername,
  validateUsername,
};

/** Minimum allowed password character length. */
export const MIN_PASSWORD_LENGTH = 4;

/** Maximum allowed password character length. */
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * Validates password format and length constraints.
 *
 * @param password - Password to validate.
 * @throws Error if password fails length or format constraints.
 */
export function validatePassword(password: string): void {
  if (
    typeof password !== 'string' ||
    password.length < MIN_PASSWORD_LENGTH ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new Error(
      `Password must be between ${MIN_PASSWORD_LENGTH} and ${MAX_PASSWORD_LENGTH} characters long`,
    );
  }
}

/**
 * Generates a cryptographically secure random salt in hexadecimal encoding.
 *
 * @param byteLength - Number of random bytes (defaults to 16).
 * @returns Hex-encoded random salt string.
 */
export function generateSalt(byteLength = 16): string {
  return crypto.randomBytes(byteLength).toString('hex');
}

/**
 * Generates a default secret key for HMAC token signing.
 *
 * @param prefix - Prefix label for the secret (defaults to 'tetherdb-secret').
 * @returns Hex-encoded secret key string.
 */
export function generateTokenSecret(prefix = 'tetherdb-secret'): string {
  return `${prefix}-${crypto.randomBytes(16).toString('hex')}`;
}

/**
 * Hashes a plaintext password using the scrypt key derivation function with a given salt.
 *
 * @param password - Account password.
 * @param salt - Hex-encoded cryptographic salt.
 * @returns Hex-encoded scrypt password hash.
 */
export function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 32).toString('hex');
}

/**
 * Verifies a plaintext password against a stored scrypt hash using timing-safe comparison.
 *
 * @param password - Candidate password.
 * @param salt - Cryptographic salt used for hashing.
 * @param expectedHash - Stored hex-encoded password hash.
 * @returns `true` if credentials match, otherwise `false`.
 */
export function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
): boolean {
  if (typeof password !== 'string' || password.length === 0) {
    return false;
  }
  const hash = hashPassword(password, salt);
  if (hash.length !== expectedHash.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expectedHash));
}

/**
 * Creates a new UserAccount record with scrypt password hashing, validation, and metadata timestamps.
 *
 * @param username - Desired username.
 * @param password - Account password.
 * @param id - Optional explicit user UUID (generates a random UUID if omitted).
 * @returns Initialized `UserAccount` object.
 */
export function createUserAccount(
  username: string,
  password: string,
  id?: string,
): UserAccount {
  const cleanUsername = validateUsername(username);
  validatePassword(password);

  const userId = id ?? crypto.randomUUID();
  const salt = generateSalt();
  const passwordHash = hashPassword(password, salt);
  const now = Date.now();

  return {
    id: userId,
    username: cleanUsername,
    passwordHash,
    salt,
    createdAt: now,
    lastLoginAt: now,
  };
}

/**
 * Generates an HMAC-SHA256 signed session token from an authenticated session and secret key.
 *
 * @param session - Authenticated user session.
 * @param secret - Secret signing key.
 * @returns Base64url-encoded signed session token.
 */
export function generateSessionToken(
  session: AuthSession,
  secret: string,
): string {
  const payload = JSON.stringify({
    userId: session.userId,
    username: session.username,
    iat: Date.now(),
  });
  const encodedPayload = Buffer.from(payload).toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');
  return `${encodedPayload}.${signature}`;
}

/**
 * Verifies an HMAC-SHA256 signed session token and extracts the decoded `AuthSession`.
 *
 * @param token - Base64url-encoded signed session token.
 * @param secret - Secret signing key.
 * @returns Decoded `AuthSession` if valid and authentic; otherwise `null`.
 */
export function verifySessionToken(
  token: string,
  secret: string,
): AuthSession | null {
  if (typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(encodedPayload)
    .digest('base64url');

  if (signature.length !== expectedSig.length) {
    return null;
  }

  if (
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))
  ) {
    return null;
  }

  try {
    const decoded = Buffer.from(encodedPayload, 'base64url').toString('utf-8');
    const payload: { userId?: unknown; username?: unknown } =
      JSON.parse(decoded);
    if (
      typeof payload.userId !== 'string' ||
      typeof payload.username !== 'string'
    ) {
      return null;
    }
    return {
      userId: payload.userId,
      username: payload.username,
    };
  } catch {
    return null;
  }
}
