import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Default token expiration window in seconds (7 days). */
export const DEFAULT_TOKEN_EXPIRES_IN = 7 * 24 * 60 * 60;

/** Default scrypt parameters matching standard cryptographic best practices. */
const SCRYPT_OPTIONS: crypto.ScryptOptions = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
};

/**
 * Loads a persistent HMAC signing secret from `<baseDir>/.secret`, or generates and saves one
 * with restricted permissions (`0o600`) if it does not yet exist.
 *
 * @param baseDir - Directory path where `.secret` is stored.
 * @returns 64-character hex secret string.
 */
export function getOrCreateKeyfileSecret(baseDir: string): string {
  const secretPath = path.join(baseDir, '.secret');
  try {
    if (fs.existsSync(secretPath)) {
      const existing = fs.readFileSync(secretPath, 'utf-8').trim();
      if (existing.length >= 32) {
        return existing;
      }
    }
  } catch {
    // Ignore read error and fallback to creation
  }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(baseDir, { recursive: true });
    fs.writeFileSync(secretPath, generated, {
      encoding: 'utf-8',
      mode: 0o600,
    });
  } catch {
    // If writing fails, return generated in-memory secret
  }
  return generated;
}

/**
 * Hashes a plaintext password using standard scrypt key derivation.
 *
 * @param password - The plaintext password to hash.
 * @returns Formatted hash string `scrypt$salt$derivedKey`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize('NFKC'),
      salt,
      64,
      SCRYPT_OPTIONS,
      (err, derivedKey) => {
        if (err) return reject(err);
        resolve(`scrypt$${salt}$${derivedKey.toString('hex')}`);
      },
    );
  });
}

/**
 * Verifies a plaintext password against a stored scrypt hash using timing-safe comparison.
 *
 * @param password - The plaintext password to check.
 * @param storedHash - Stored hash string `scrypt$salt$derivedKey`.
 * @returns `true` if password matches; otherwise `false`.
 */
export async function verifyPasswordHash(
  password: string,
  storedHash: string,
): Promise<boolean> {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const [, salt, expectedHex] = parts;
  return new Promise((resolve) => {
    crypto.scrypt(
      password.normalize('NFKC'),
      salt,
      64,
      SCRYPT_OPTIONS,
      (err, derivedKey) => {
        if (err) return resolve(false);
        const expectedBuf = Buffer.from(expectedHex, 'hex');
        if (derivedKey.length !== expectedBuf.length) return resolve(false);
        resolve(crypto.timingSafeEqual(derivedKey, expectedBuf));
      },
    );
  });
}

/**
 * Generates a signed, URL-safe session token.
 *
 * @param userId - User account identifier.
 * @param username - Normalized username.
 * @param secret - Signing secret.
 * @param expiresInSeconds - Token expiration duration.
 * @returns Signed token string.
 */
export function createSessionToken(
  userId: string,
  username: string,
  secret: string,
  expiresInSeconds = DEFAULT_TOKEN_EXPIRES_IN,
): string {
  const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
  const payload = `${userId}:${username}:${expiresAt}`;
  const payloadB64 = Buffer.from(payload, 'utf-8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${signature}`;
}

/**
 * Verifies a signed session token and returns decoded payload.
 *
 * @param token - Token string to verify.
 * @param secret - Signing secret.
 * @returns Decoded payload or `null` if invalid or expired.
 */
export function verifySessionToken(
  token: string,
  secret: string,
): { userId: string; username: string; expiresAt: number } | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, signature] = parts;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');

  if (
    signature.length !== expectedSig.length ||
    !crypto.timingSafeEqual(
      Buffer.from(signature, 'utf-8'),
      Buffer.from(expectedSig, 'utf-8'),
    )
  ) {
    return null;
  }

  try {
    const raw = Buffer.from(payloadB64, 'base64url').toString('utf-8');
    const [userId, username, expiresAtStr] = raw.split(':');
    const expiresAt = Number.parseInt(expiresAtStr, 10);
    if (
      !userId ||
      !username ||
      Number.isNaN(expiresAt) ||
      expiresAt < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return { userId, username, expiresAt };
  } catch {
    return null;
  }
}
