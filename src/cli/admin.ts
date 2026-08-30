import {
  AdminClient,
  type AdminTarget,
  decodeAdminToken,
  LocalAdminTarget,
  type ResolvedAdminContext,
} from '../server/admin.js';
import { readServerLock } from '../server/shared/lock.js';
import { createBackend, StorageType } from './backend.js';

export {
  AdminClient,
  type AdminTarget,
  LocalAdminTarget,
  type ResolvedAdminContext,
};

/**
 * Resolves the appropriate administration target for CLI operations.
 * If a token is provided or a server lock is detected with an active adminSecret, connects via HTTP (`AdminClient`);
 * otherwise instantiates an offline `Storage` engine (`LocalAdminTarget`).
 *
 * @param dir - Data directory.
 * @param backend - Storage type if operating offline.
 * @param token - Optional admin connection token.
 * @returns Resolved administrative context.
 */
export async function resolveAdminTarget(
  dir = '.data',
  backend: StorageType = StorageType.Memory,
  token?: string,
): Promise<ResolvedAdminContext> {
  if (token) {
    const { host, port, secret } = decodeAdminToken(token);
    const client = new AdminClient(port, host, secret);
    return {
      target: client,
      isRemote: true,
      lock: {
        pid: 0,
        port,
        host,
        adminSecret: secret,
        startedAt: Date.now(),
        type: StorageType.Memory,
      },
      close: async () => {},
    };
  }

  const lock = readServerLock(dir);
  if (lock?.adminSecret) {
    const client = new AdminClient(lock.port, lock.host, lock.adminSecret);
    return {
      target: client,
      isRemote: true,
      lock,
      close: async () => {},
    };
  }

  const storage = createBackend(backend, dir);
  const target = new LocalAdminTarget(storage);
  return {
    target,
    isRemote: false,
    lock: null,
    close: async () => {
      await target.close();
    },
  };
}
