import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TetherServerError, TetherServerErrorCode } from '../errors.js';
import type { BackendType } from '../storage/storage.js';

/**
 * Metadata recorded inside the server lockfile.
 */
export interface ServerLockInfo {
  /** Process identifier running the server. */
  pid: number;
  /** Host interface the server is bound to. */
  host: string;
  /** Port number the server is bound to. */
  port: number;
  /** Storage backend type ('sqlite', 'file', or 'memory'). */
  backend: BackendType;
  /** Epoch timestamp when the server acquired the lock. */
  startedAt: number;
  /** Ephemeral secret used by the CLI to authenticate against local admin API. */
  adminSecret?: string;
}

/**
 * Handle representing an active exclusive server lock.
 */
export interface ServerLockHandle {
  /** Lock metadata information. */
  readonly info: ServerLockInfo;
  /** Path to the active lockfile on disk. */
  readonly lockPath: string;
  /** Releases the lock and removes the lockfile. */
  release(): void;
}

/**
 * Checks whether a given operating system process ID is currently alive.
 *
 * @param pid - Process ID to check.
 * @returns `true` if the process is active; otherwise `false`.
 */
export function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/**
 * Reads active server lock metadata from a storage base directory if present and live.
 * Stale locks from terminated processes are ignored.
 *
 * @param baseDir - Storage base directory.
 * @returns ServerLockInfo if an active server is running, or `null`.
 */
export function readServerLock(baseDir: string): ServerLockInfo | null {
  const lockPath = path.join(baseDir, 'server.lock');
  try {
    if (!fs.existsSync(lockPath)) return null;
    const content = fs.readFileSync(lockPath, 'utf-8');
    const info = JSON.parse(content) as ServerLockInfo;
    if (typeof info.pid === 'number' && isProcessAlive(info.pid)) {
      return info;
    }
    // Stale lock from dead process - clean up immediately
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore
    }
    return null;
  } catch {
    try {
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Ignore
    }
    return null;
  }
}

/**
 * Validates that no external TetherDB server process is actively running on this data directory.
 *
 * @param baseDir - Storage base directory.
 * @param backendLabel - Storage backend description ('sqlite' | 'file' | 'storage').
 * @throws TetherServerError if an active server lock is held by another process.
 */
export function assertNoActiveServerLock(
  baseDir: string,
  backendLabel = 'storage',
): void {
  const lock = readServerLock(baseDir);
  if (lock && lock.pid !== process.pid) {
    throw new TetherServerError(
      TetherServerErrorCode.NotSupported,
      `Cannot modify ${backendLabel} storage directly while server is running (PID ${lock.pid})`,
    );
  }
}

/**
 * Acquires an exclusive server lock on the specified directory to prevent multiple instances
 * from running against the same data storage.
 *
 * @param baseDir - Directory path where the lockfile will be maintained.
 * @param details - Port, host, backend, and optional adminSecret to write to the lockfile.
 * @returns ServerLockHandle representing the active lock.
 * @throws TetherServerError if another active server already holds the lock.
 */
export function acquireServerLock(
  baseDir: string,
  details: Omit<ServerLockInfo, 'pid' | 'startedAt'>,
): ServerLockHandle {
  fs.mkdirSync(baseDir, { recursive: true });
  const lockPath = path.join(baseDir, 'server.lock');

  const existing = readServerLock(baseDir);
  if (existing && existing.pid !== process.pid) {
    throw new TetherServerError(
      TetherServerErrorCode.AlreadyExists,
      'A TetherDB server is already running on this data directory',
    );
  }

  // If a stale lockfile exists from a dead process, remove it
  if (fs.existsSync(lockPath)) {
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore
    }
  }

  const adminSecret =
    details.adminSecret ?? crypto.randomBytes(32).toString('hex');

  const info: ServerLockInfo = {
    pid: process.pid,
    port: details.port,
    host: details.host,
    backend: details.backend,
    startedAt: Date.now(),
    adminSecret,
  };

  const payload = JSON.stringify(info, null, 2);
  try {
    fs.writeFileSync(lockPath, payload, {
      encoding: 'utf-8',
      mode: 0o600,
      flag: existing?.pid === process.pid ? 'w' : 'wx',
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const active = readServerLock(baseDir);
      if (active && active.pid !== process.pid) {
        throw new TetherServerError(
          TetherServerErrorCode.AlreadyExists,
          'A TetherDB server is already running on this data directory',
        );
      }
      fs.writeFileSync(lockPath, payload, {
        encoding: 'utf-8',
        mode: 0o600,
      });
    } else {
      throw err;
    }
  }

  let isReleased = false;
  const release = () => {
    if (isReleased) return;
    isReleased = true;
    process.removeListener('exit', release);
    try {
      if (fs.existsSync(lockPath)) {
        const current = JSON.parse(
          fs.readFileSync(lockPath, 'utf-8'),
        ) as ServerLockInfo;
        if (current.pid === process.pid) {
          fs.unlinkSync(lockPath);
        }
      }
    } catch {
      // Ignore cleanup error on shutdown
    }
  };

  process.once('exit', release);

  return {
    info,
    lockPath,
    release,
  };
}
