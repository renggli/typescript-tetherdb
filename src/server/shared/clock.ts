import type { ChangeRecord, StoredRecord } from '../../shared/types.js';

/**
 * Determines whether an incoming mutation should overwrite an existing stored record
 * using Last-Write-Wins (LWW) conflict resolution.
 *
 * Conflict resolution rules:
 * 1. If no existing record exists, returns `true`.
 * 2. If incoming timestamp is strictly greater, returns `true`.
 * 3. If incoming timestamp is strictly less, returns `false`.
 * 4. If timestamps are equal, performs deterministic lexicographical tie-breaking using `clientId`.
 *
 * @param incoming - The candidate change record with timestamp and optional client metadata.
 * @param existing - The current record stored locally or on the server.
 * @returns `true` if the incoming change wins the conflict and should overwrite the existing record; otherwise `false`.
 */
export function shouldOverwrite(
  incoming: Pick<ChangeRecord, 'timestamp'> & {
    clientId?: string;
    version?: number;
  },
  existing?: Pick<StoredRecord, 'timestamp' | 'version'> & {
    clientId?: string;
  },
): boolean {
  if (!existing) return true;

  if (incoming.timestamp > existing.timestamp) {
    return true;
  }
  if (incoming.timestamp < existing.timestamp) {
    return false;
  }

  const incomingClient = incoming.clientId ?? '';
  const existingClient = existing.clientId ?? '';
  return incomingClient >= existingClient;
}
