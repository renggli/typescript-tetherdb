import { TetherServerError, TetherServerErrorCode } from '../server/index.js';
import type { ChangeRecord, TableSettings } from '../shared/types.js';

export class AdminClient {
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
        `Failed to connect to running server: ${(err as Error).message}`,
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

  async getStatus(): Promise<
    import('../server/storage/storage.js').StorageStatus
  > {
    return this.request('GET', '/admin/status');
  }

  async getTables(): Promise<
    Array<{ name: string; settings?: TableSettings }>
  > {
    return this.request('GET', '/admin/tables');
  }

  async createTable(
    name: string,
    settings?: TableSettings,
  ): Promise<{ name: string; settings?: TableSettings }> {
    return this.request('POST', '/admin/tables', { name, settings });
  }

  async getTable(
    name: string,
  ): Promise<{ name: string; settings?: TableSettings }> {
    return this.request('GET', `/admin/tables/${encodeURIComponent(name)}`);
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
    table: string,
    user?: string,
  ): Promise<import('../shared/types.js').SnapshotRecord[]> {
    const params = new URLSearchParams({ table });
    if (user) params.set('user', user);
    return this.request('GET', `/admin/records?${params.toString()}`);
  }

  async applyChanges(
    changes: ChangeRecord[],
    userId?: string,
  ): Promise<{ applied: ChangeRecord[]; newSeq: number }> {
    return this.request('POST', '/admin/records', { userId, changes });
  }

  async runMaintenance(
    action: 'checkpoint' | 'vacuum' | 'prune',
    keepCount?: number,
    tableName?: string,
  ): Promise<import('../server/storage/storage.js').MaintenanceResult> {
    return this.request('POST', '/admin/maintenance', {
      action,
      keepCount,
      tableName,
    });
  }

  async stop(): Promise<{ message: string }> {
    return this.request('POST', '/admin/stop');
  }
}
