import { verifySessionToken } from '../../crypto.js';
import { TetherServerError, TetherServerErrorCode } from '../../errors.js';
import { validateAppId } from '../../validate.js';
import type { AppStorage } from '../app.js';
import type {
  MaintenanceResult,
  Storage,
  StorageOptions,
  StorageStatus,
} from '../storage.js';
import type { UserStorage } from '../user.js';

/**
 * Common abstract base class for Storage implementations.
 */
export abstract class BaseStorage implements Storage {
  readonly options?: StorageOptions;

  constructor(options?: StorageOptions) {
    this.options = options;
  }

  /** Backend persistence type name ('file', 'memory', 'sqlite'). */
  abstract readonly backend: string;

  /** Secret key used for signing session tokens. */
  abstract readonly secret: string;

  /** Optional storage base directory if disk-backed. */
  protected getBaseDir(): string | undefined {
    return undefined;
  }

  abstract createApp(id: string): Promise<AppStorage>;
  abstract getApp(id: string): Promise<AppStorage | undefined>;
  abstract getApps(): Promise<AppStorage[]>;
  abstract createUser(username: string, password: string): Promise<UserStorage>;
  abstract getUser(id: string): Promise<UserStorage | undefined>;
  abstract getUserByUsername(
    username: string,
  ): Promise<UserStorage | undefined>;
  abstract getUsers(): Promise<UserStorage[]>;
  abstract checkpoint(appId?: string): Promise<MaintenanceResult>;
  abstract vacuum(appId?: string): Promise<MaintenanceResult>;
  abstract prune(
    appId?: string,
    keepCount?: number,
  ): Promise<MaintenanceResult>;

  async getUserByToken(token: string): Promise<UserStorage | undefined> {
    const payload = verifySessionToken(token, this.secret);
    if (!payload) return undefined;
    return this.getUser(payload.userId);
  }

  async getStatus(appId?: string): Promise<StorageStatus> {
    const users = await this.getUsers();
    const allApps = await this.getApps();
    const targetApps = filterTargetApps(allApps, appId);
    const apps = await buildAppSummaries(targetApps);

    const status: StorageStatus = {
      backend: this.backend,
      usersCount: users.length,
      appsCount: allApps.length,
      apps,
    };
    const baseDir = this.getBaseDir();
    if (baseDir !== undefined) {
      status.baseDir = baseDir;
    }
    return status;
  }
}

/**
 * Filters the list of applications by an optional target appId, validating format and existence.
 */
export function filterTargetApps(
  allApps: AppStorage[],
  appId?: string,
): AppStorage[] {
  const targetApps = appId
    ? allApps.filter((a) => a.id === validateAppId(appId))
    : allApps;

  if (appId && targetApps.length === 0) {
    throw new TetherServerError(
      TetherServerErrorCode.NotFound,
      `Application "${appId}" not found`,
    );
  }

  return targetApps;
}

/**
 * Builds array of application summaries including their table names.
 */
export async function buildAppSummaries(
  apps: AppStorage[],
): Promise<Array<{ id: string; tables: string[] }>> {
  const appSummaries: Array<{ id: string; tables: string[] }> = [];
  for (const app of apps) {
    const tables = await app.getTables();
    appSummaries.push({
      id: app.id,
      tables: tables.map((t) => t.name),
    });
  }
  return appSummaries;
}
