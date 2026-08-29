import {
  AdminClient,
  type AdminTarget,
  LocalAdminTarget,
  type ResolvedAdminContext,
} from '../server/admin.js';
import { readServerLock } from '../server/shared/lock.js';
import { BackendType, createBackend } from './backend.js';

export {
  AdminClient,
  type AdminTarget,
  LocalAdminTarget,
  type ResolvedAdminContext,
};

/**
 * Resolves the appropriate administration target for CLI operations.
 * If a server lock is detected with an active adminSecret, connects via HTTP (`AdminClient`);
 * otherwise instantiates an offline `Storage` engine (`LocalAdminTarget`).
 *
 * @param dir - Data directory.
 * @param backend - Storage backend type if operating offline.
 * @returns Resolved administrative context.
 */
export async function resolveAdminTarget(
  dir = '.data',
  backend: BackendType = BackendType.Memory,
): Promise<ResolvedAdminContext> {
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
