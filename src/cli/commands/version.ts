import {
  formatVersion,
  getServerVersion,
} from '../../server/shared/version.js';
import { resolveAdminTarget } from '../admin.js';
import type { StorageType } from '../backend.js';

/**
 * Result returned by the 'version' command.
 */
export interface VersionResult {
  /** Local client/CLI package version. */
  local: string;
  /** Remote running server package version if available. */
  remote?: string;
  /** Local git commit hash if running in a git checkout. */
  localHash?: string;
  /** Remote git commit hash if running in a git checkout. */
  remoteHash?: string;
}

/**
 * Handles the 'version' command to display local and remote TetherDB versions.
 * Always displays both local and remote version (or unreachable if offline).
 *
 * @param dir - Data directory.
 * @param backend - Storage backend type.
 * @param token - Optional admin connection token.
 * @returns Object with local and optional remote version.
 */
export async function handleVersionCommand(
  dir = '.data',
  backend?: StorageType,
  token?: string,
): Promise<VersionResult> {
  const localInfo = getServerVersion();
  let remoteInfo: { version: string; hash?: string } | undefined;

  try {
    const adminContext = await resolveAdminTarget(dir, backend, token);
    if (adminContext.isRemote) {
      remoteInfo = await adminContext.target.getVersion();
    }
    await adminContext.close();
  } catch {
    // Ignore remote connection failure when inspecting version
  }

  const localFormatted = formatVersion(localInfo);

  if (remoteInfo) {
    const remoteFormatted = formatVersion(remoteInfo);
    console.log(`tetherdb ${localFormatted} (remote ${remoteFormatted})`);
  } else {
    console.warn('Warning: Server not running or unreachable');
    console.log(`tetherdb ${localFormatted} (remote: unreachable)`);
  }

  return {
    local: localInfo.version,
    remote: remoteInfo?.version,
    localHash: localInfo.hash,
    remoteHash: remoteInfo?.hash,
  };
}
