/**
 * Generates a unique, URL-safe client identifier.
 *
 * Uses `crypto.randomUUID()` when available in modern runtime environments,
 * falling back to pseudo-random entropy combined with timestamp components.
 *
 * @returns A unique client identifier string.
 */
export function generateClientId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `client_${Math.random().toString(36).substring(2, 11)}_${Date.now().toString(36)}`;
}
