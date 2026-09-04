import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TETHER_VERSION } from '../../shared/version.js';

/**
 * Server version details including package version and optional git commit hash.
 */
export interface ServerVersion {
  /** Package version declared in package.json. */
  version: string;
  /** Git commit hash if running within a git checkout. */
  hash?: string;
}

/**
 * Formats server version information into a human-readable string.
 *
 * @param info - Version details.
 * @returns Formatted version string (e.g. "0.2.0 (d37d698)").
 */
export function formatVersion(info: ServerVersion): string {
  return info.hash ? `${info.version} (${info.hash})` : info.version;
}

let cachedVersion: ServerVersion | null = null;

/**
 * Resolves the currently running TetherDB version and git commit hash if available.
 *
 * @returns Server version object.
 */
export function getServerVersion(): ServerVersion {
  if (cachedVersion !== null) {
    return cachedVersion;
  }
  const version = resolvePackageVersion();
  const hash = resolveGitHash();
  cachedVersion = { version, ...(hash ? { hash } : {}) };
  return cachedVersion;
}

// -- Private Helpers --------------------------------------------------------

function resolvePackageVersion(): string {
  try {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    while (dir !== path.dirname(dir)) {
      const pkgFile = path.join(dir, 'package.json');
      if (fs.existsSync(pkgFile)) {
        const data = JSON.parse(fs.readFileSync(pkgFile, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (data.name === 'tetherdb' && typeof data.version === 'string') {
          return data.version;
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    // Fall back to constant
  }
  return TETHER_VERSION;
}

function resolveGitHash(): string | undefined {
  try {
    const hash = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
    return hash.length > 0 ? hash : undefined;
  } catch {
    return undefined;
  }
}
