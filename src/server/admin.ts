import type {
  ChangeRecord,
  SnapshotRecord,
  TableSettings,
} from '../shared/types.js';
import { OperationType } from '../shared/types.js';
import { TetherServerError, TetherServerErrorCode } from './errors.js';
import type { ServerLockInfo } from './lock.js';
import type {
  MaintenanceResult,
  Storage,
  StorageStatus,
} from './storage/storage.js';

/**
 * Common administrative interface for inspecting and managing a TetherDB database,
 * whether connected to a running remote server over HTTP or operating directly on local offline storage.
 */
export interface AdminTarget {
  /** Retrieves storage summary statistics and table listings. */
  getStatus(): Promise<StorageStatus>;

  /** Retrieves all table definitions. */
  getTables(): Promise<Array<{ name: string; settings?: TableSettings }>>;

  /** Retrieves a specific table definition if it exists. */
  getTable(
    name: string,
  ): Promise<{ name: string; settings?: TableSettings } | undefined>;

  /** Creates a new table with optional settings. */
  createTable(
    name: string,
    settings?: TableSettings,
  ): Promise<{ name: string; settings?: TableSettings }>;

  /** Updates settings on an existing table. */
  updateTable(
    name: string,
    settings: Partial<TableSettings>,
  ): Promise<{ name: string; settings?: TableSettings }>;

  /** Deletes a table and all its stored records. */
  deleteTable(name: string): Promise<{ deleted: boolean }>;

  /** Retrieves all registered user accounts. */
  getUsers(): Promise<
    Array<{ id: string; username: string; createdAt: number }>
  >;

  /** Registers a new user account with credentials. */
  createUser(
    username: string,
    password: string,
  ): Promise<{ id: string; username: string; createdAt: number }>;

  /** Deletes a user account and associated partitions. */
  deleteUser(id: string): Promise<{ deleted: boolean }>;

  /** Retrieves records from a table partition. */
  getRecords(tableName: string, userId?: string): Promise<SnapshotRecord[]>;

  /** Puts or updates a record payload in a table partition. */
  putRecord(
    tableName: string,
    id: string,
    data: unknown,
    userId?: string,
  ): Promise<void>;

  /** Deletes a record from a table partition. */
  deleteRecord(tableName: string, id: string, userId?: string): Promise<void>;

  /** Truncates WAL log files for SQLite databases. */
  checkpoint(tableName?: string): Promise<MaintenanceResult>;

  /** Reclaims unused disk space and defragments storage files. */
  vacuum(): Promise<MaintenanceResult>;

  /** Prunes changelog entries older than the retention threshold. */
  prune(keepCount?: number, tableName?: string): Promise<MaintenanceResult>;

  /** Requests the running server to gracefully shut down. */
  stop?(): Promise<{ message: string }>;

  /** Closes underlying storage connections or releases resources. */
  close?(): Promise<void>;
}

/**
 * Result context returned when resolving an administrative target.
 */
export interface ResolvedAdminContext {
  /** Active administration target (RemoteAdminTarget or LocalAdminTarget). */
  target: AdminTarget;
  /** Whether the target is a remote running server. */
  isRemote: boolean;
  /** Server lock information if a server is running. */
  lock: ServerLockInfo | null;
  /** Cleanup function closing connections or local storage handles. */
  close(): Promise<void>;
}

/**
 * Remote administration client communicating with a running TetherServer instance over HTTP.
 */
export class AdminClient implements AdminTarget {
  readonly baseUrl: string;
  readonly adminSecret: string;

  constructor(port: number, host: string, adminSecret: string) {
    const safeHost = host === '0.0.0.0' ? '127.0.0.1' : host;
    this.baseUrl = `http://${safeHost}:${port}`;
    this.adminSecret = adminSecret;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.adminSecret}`,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new TetherServerError(
        TetherServerErrorCode.InternalError,
        `Failed to connect to running server at ${this.baseUrl}: ${(err as Error).message}`,
      );
    }

    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new TetherServerError(
        TetherServerErrorCode.InternalError,
        data.error ?? `Server returned HTTP ${res.status}`,
      );
    }

    return (await res.json()) as T;
  }

  async getStatus(): Promise<StorageStatus> {
    return this.request('GET', '/admin/status');
  }

  async getTables(): Promise<
    Array<{ name: string; settings?: TableSettings }>
  > {
    return this.request('GET', '/admin/tables');
  }

  async getTable(
    name: string,
  ): Promise<{ name: string; settings?: TableSettings } | undefined> {
    try {
      return await this.request(
        'GET',
        `/admin/tables/${encodeURIComponent(name)}`,
      );
    } catch {
      return undefined;
    }
  }

  async createTable(
    name: string,
    settings?: TableSettings,
  ): Promise<{ name: string; settings?: TableSettings }> {
    return this.request('POST', '/admin/tables', { name, settings });
  }

  async updateTable(
    name: string,
    settings: Partial<TableSettings>,
  ): Promise<{ name: string; settings?: TableSettings }> {
    return this.request('PATCH', `/admin/tables/${encodeURIComponent(name)}`, {
      settings,
    });
  }

  async deleteTable(name: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/admin/tables/${encodeURIComponent(name)}`);
  }

  async getUsers(): Promise<
    Array<{ id: string; username: string; createdAt: number }>
  > {
    return this.request('GET', '/admin/users');
  }

  async createUser(
    username: string,
    password: string,
  ): Promise<{ id: string; username: string; createdAt: number }> {
    return this.request('POST', '/admin/users', { username, password });
  }

  async deleteUser(id: string): Promise<{ deleted: boolean }> {
    return this.request('DELETE', `/admin/users/${encodeURIComponent(id)}`);
  }

  async getRecords(
    tableName: string,
    userId?: string,
  ): Promise<SnapshotRecord[]> {
    const params = new URLSearchParams({ table: tableName });
    if (userId) params.set('user', userId);
    return this.request('GET', `/admin/records?${params.toString()}`);
  }

  async putRecord(
    tableName: string,
    id: string,
    data: unknown,
    userId?: string,
  ): Promise<void> {
    const change: ChangeRecord = {
      table: tableName,
      id,
      op: OperationType.Put,
      data,
      timestamp: Date.now(),
      clientId: 'admin-cli',
    };
    await this.request('POST', '/admin/records', {
      userId,
      changes: [change],
    });
  }

  async deleteRecord(
    tableName: string,
    id: string,
    userId?: string,
  ): Promise<void> {
    const change: ChangeRecord = {
      table: tableName,
      id,
      op: OperationType.Delete,
      timestamp: Date.now(),
      clientId: 'admin-cli',
    };
    await this.request('POST', '/admin/records', {
      userId,
      changes: [change],
    });
  }

  async checkpoint(tableName?: string): Promise<MaintenanceResult> {
    return this.request('POST', '/admin/maintenance', {
      action: 'checkpoint',
      tableName,
    });
  }

  async vacuum(): Promise<MaintenanceResult> {
    return this.request('POST', '/admin/maintenance', { action: 'vacuum' });
  }

  async prune(
    keepCount?: number,
    tableName?: string,
  ): Promise<MaintenanceResult> {
    return this.request('POST', '/admin/maintenance', {
      action: 'prune',
      keepCount,
      tableName,
    });
  }

  async stop(): Promise<{ message: string }> {
    return this.request('POST', '/admin/stop');
  }
}

/**
 * Local administration target operating directly against an offline Storage backend.
 */
export class LocalAdminTarget implements AdminTarget {
  constructor(readonly storage: Storage) {}

  async getStatus(): Promise<StorageStatus> {
    return this.storage.getStatus();
  }

  async getTables(): Promise<
    Array<{ name: string; settings?: TableSettings }>
  > {
    const tables = await this.storage.getTables();
    return tables.map((t) => ({ name: t.name, settings: t.settings }));
  }

  async getTable(
    name: string,
  ): Promise<{ name: string; settings?: TableSettings } | undefined> {
    const table = await this.storage.getTable(name);
    return table ? { name: table.name, settings: table.settings } : undefined;
  }

  async createTable(
    name: string,
    settings?: TableSettings,
  ): Promise<{ name: string; settings?: TableSettings }> {
    const table = await this.storage.createTable(name, settings);
    return { name: table.name, settings: table.settings };
  }

  async updateTable(
    name: string,
    settings: Partial<TableSettings>,
  ): Promise<{ name: string; settings?: TableSettings }> {
    const table = await this.storage.getTable(name);
    if (!table) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        `Table "${name}" not found`,
      );
    }
    const updatedSettings = await table.updateSettings(settings);
    return { name: table.name, settings: updatedSettings };
  }

  async deleteTable(name: string): Promise<{ deleted: boolean }> {
    const table = await this.storage.getTable(name);
    if (!table) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        `Table "${name}" not found`,
      );
    }
    await table.delete();
    return { deleted: true };
  }

  async getUsers(): Promise<
    Array<{ id: string; username: string; createdAt: number }>
  > {
    const users = await this.storage.getUsers();
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      createdAt: u.createdAt,
    }));
  }

  async createUser(
    username: string,
    password: string,
  ): Promise<{ id: string; username: string; createdAt: number }> {
    const user = await this.storage.createUser(username, password);
    return {
      id: user.id,
      username: user.username,
      createdAt: user.createdAt,
    };
  }

  async deleteUser(id: string): Promise<{ deleted: boolean }> {
    const user = await this.storage.getUser(id);
    if (!user) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        `User "${id}" not found`,
      );
    }
    await user.delete();
    return { deleted: true };
  }

  async getRecords(
    tableName: string,
    userId?: string,
  ): Promise<SnapshotRecord[]> {
    const table = await this.storage.getTable(tableName);
    if (!table) {
      throw new TetherServerError(
        TetherServerErrorCode.NotFound,
        `Table "${tableName}" not found`,
      );
    }
    const user = userId ? await this.storage.getUser(userId) : undefined;
    const records = await table.getAllRecords(user);
    return records.map((r) => ({
      table: tableName,
      id: r.id,
      data: r.data,
      version: r.version,
      timestamp: r.timestamp,
      clientId: r.clientId,
      deleted: r.deleted,
      ownerId: r.ownerId,
    }));
  }

  async putRecord(
    tableName: string,
    id: string,
    data: unknown,
    userId?: string,
  ): Promise<void> {
    const user = userId ? await this.storage.getUser(userId) : undefined;
    await this.storage.applyChanges(user, [
      {
        table: tableName,
        id,
        op: OperationType.Put,
        data,
        timestamp: Date.now(),
        clientId: 'admin-cli',
      },
    ]);
  }

  async deleteRecord(
    tableName: string,
    id: string,
    userId?: string,
  ): Promise<void> {
    const user = userId ? await this.storage.getUser(userId) : undefined;
    await this.storage.applyChanges(user, [
      {
        table: tableName,
        id,
        op: OperationType.Delete,
        timestamp: Date.now(),
        clientId: 'admin-cli',
      },
    ]);
  }

  async checkpoint(tableName?: string): Promise<MaintenanceResult> {
    return this.storage.checkpoint(tableName);
  }

  async vacuum(): Promise<MaintenanceResult> {
    return this.storage.vacuum();
  }

  async prune(
    keepCount?: number,
    tableName?: string,
  ): Promise<MaintenanceResult> {
    return this.storage.prune(keepCount, tableName);
  }

  async close(): Promise<void> {
    await this.storage.close?.();
  }
}
