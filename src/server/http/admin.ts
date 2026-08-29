import * as crypto from 'node:crypto';
import type * as http from 'node:http';
import {
  type ChangeRecord,
  OperationType,
  type TableSettings,
} from '../../shared/types.js';
import { TetherServerError, TetherServerErrorCode } from '../errors.js';
import type { MaintenanceResult, Storage } from '../storage/storage.js';
import type { CorsOptions } from './cors.js';
import { readJsonBody, sendJson } from './json.js';

export interface AdminRouteContext {
  storage: Storage;
  adminSecret: string;
  corsConfig: CorsOptions | null;
  closeServer: () => Promise<void>;
}

/**
 * Validates the admin authorization secret header on incoming requests.
 *
 * @param req - Incoming HTTP request.
 * @param expectedSecret - Configured administrative secret token.
 * @throws TetherServerError if token is invalid or missing.
 */
export function assertAdminAuth(
  req: http.IncomingMessage,
  expectedSecret: string,
): void {
  const authHeader = req.headers.authorization ?? '';
  const xAdmin = req.headers['x-admin-secret'];
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : typeof xAdmin === 'string'
      ? xAdmin.trim()
      : '';

  const tokenBuf = Buffer.from(token, 'utf-8');
  const secretBuf = Buffer.from(expectedSecret, 'utf-8');

  if (
    tokenBuf.length !== secretBuf.length ||
    !crypto.timingSafeEqual(tokenBuf, secretBuf)
  ) {
    throw new TetherServerError(
      TetherServerErrorCode.Unauthorized,
      'Invalid or missing admin authorization token',
    );
  }
}

/**
 * Handles all `/admin/*` REST API requests.
 *
 * @param req - Incoming HTTP request.
 * @param res - Server HTTP response.
 * @param url - Parsed request URL.
 * @param basePath - Configured server base path.
 * @param ctx - Administrative context (storage, secret, shutdown callback).
 * @returns `true` if route was matched and handled, `false` otherwise.
 */
export async function handleAdminRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  basePath: string,
  ctx: AdminRouteContext,
): Promise<boolean> {
  assertAdminAuth(req, ctx.adminSecret);
  const method = req.method?.toUpperCase();
  const adminPath = url.pathname.slice(`${basePath}/admin`.length);

  // GET /admin/status
  if (method === 'GET' && adminPath === '/status') {
    const status = await ctx.storage.getStatus();
    sendJson(res, 200, status, ctx.corsConfig, req);
    return true;
  }

  // POST /admin/maintenance
  if (method === 'POST' && adminPath === '/maintenance') {
    const body = (await readJsonBody(req)) as {
      action: 'checkpoint' | 'vacuum' | 'prune';
      keepCount?: number;
      tableName?: string;
    };
    let result: MaintenanceResult;
    if (body.action === 'checkpoint') {
      result = await ctx.storage.checkpoint(body.tableName);
    } else if (body.action === 'vacuum') {
      result = await ctx.storage.vacuum();
    } else if (body.action === 'prune') {
      result = await ctx.storage.prune(body.keepCount, body.tableName);
    } else {
      throw new TetherServerError(
        TetherServerErrorCode.InvalidInput,
        `Invalid maintenance action "${body.action}"`,
      );
    }
    sendJson(res, 200, result, ctx.corsConfig, req);
    return true;
  }

  // POST /admin/stop
  if (method === 'POST' && adminPath === '/stop') {
    sendJson(res, 200, { message: 'Server stopping' }, ctx.corsConfig, req);
    setImmediate(() => {
      ctx.closeServer().catch(() => {});
    });
    return true;
  }

  // GET /admin/tables
  if (method === 'GET' && adminPath === '/tables') {
    const tables = await ctx.storage.getTables();
    const list = tables.map((t) => ({
      name: t.name,
      settings: t.settings,
    }));
    sendJson(res, 200, list, ctx.corsConfig, req);
    return true;
  }

  // POST /admin/tables
  if (method === 'POST' && adminPath === '/tables') {
    const body = (await readJsonBody(req)) as {
      name: string;
      settings?: TableSettings;
    };
    if (!body.name) {
      throw new TetherServerError(
        TetherServerErrorCode.InvalidInput,
        'Table name is required',
      );
    }
    const table = await ctx.storage.createTable(body.name, body.settings);
    sendJson(
      res,
      201,
      { name: table.name, settings: table.settings },
      ctx.corsConfig,
      req,
    );
    return true;
  }

  // /admin/tables/:name
  if (adminPath.startsWith('/tables/')) {
    const tableName = decodeURIComponent(adminPath.slice('/tables/'.length));
    if (method === 'GET') {
      const table = await ctx.storage.getTable(tableName);
      if (!table) {
        throw new TetherServerError(
          TetherServerErrorCode.NotFound,
          `Table "${tableName}" not found`,
        );
      }
      sendJson(
        res,
        200,
        { name: table.name, settings: table.settings },
        ctx.corsConfig,
        req,
      );
      return true;
    }
    if (method === 'PATCH') {
      const body = (await readJsonBody(req)) as {
        settings: Partial<TableSettings>;
      };
      const table = await ctx.storage.getTable(tableName);
      if (!table) {
        throw new TetherServerError(
          TetherServerErrorCode.NotFound,
          `Table "${tableName}" not found`,
        );
      }
      const updated = await table.updateSettings(body.settings ?? {});
      sendJson(
        res,
        200,
        { name: table.name, settings: updated },
        ctx.corsConfig,
        req,
      );
      return true;
    }
    if (method === 'DELETE') {
      const table = await ctx.storage.getTable(tableName);
      if (!table) {
        throw new TetherServerError(
          TetherServerErrorCode.NotFound,
          `Table "${tableName}" not found`,
        );
      }
      await table.delete();
      sendJson(res, 200, { deleted: true }, ctx.corsConfig, req);
      return true;
    }
  }

  // GET /admin/users
  if (method === 'GET' && adminPath === '/users') {
    const users = await ctx.storage.getUsers();
    const list = users.map((u) => ({
      userId: u.userId,
      userName: u.userName,
      createdAt: u.createdAt,
    }));
    sendJson(res, 200, list, ctx.corsConfig, req);
    return true;
  }

  // POST /admin/users
  if (method === 'POST' && adminPath === '/users') {
    const body = (await readJsonBody(req)) as {
      userName?: string;
      password?: string;
    };
    const name = body.userName;
    if (!name || !body.password) {
      throw new TetherServerError(
        TetherServerErrorCode.InvalidInput,
        'Username and password are required',
      );
    }
    const user = await ctx.storage.createUser(name, body.password);
    sendJson(
      res,
      201,
      {
        userId: user.userId,
        userName: user.userName,
        createdAt: user.createdAt,
      },
      ctx.corsConfig,
      req,
    );
    return true;
  }

  // DELETE /admin/users/:userId
  if (adminPath.startsWith('/users/')) {
    const userId = decodeURIComponent(adminPath.slice('/users/'.length));
    if (method === 'DELETE') {
      const user = await ctx.storage.getUser(userId);
      if (!user) {
        throw new TetherServerError(
          TetherServerErrorCode.NotFound,
          `User "${userId}" not found`,
        );
      }
      await user.delete();
      sendJson(res, 200, { deleted: true }, ctx.corsConfig, req);
      return true;
    }
  }

  // /admin/records
  if (adminPath === '/records') {
    if (method === 'GET') {
      const tableName = url.searchParams.get('table');
      const userParam =
        url.searchParams.get('user') ?? url.searchParams.get('userId');
      if (!tableName) {
        throw new TetherServerError(
          TetherServerErrorCode.InvalidInput,
          'Query parameter "table" is required',
        );
      }
      const table = await ctx.storage.getTable(tableName);
      if (!table) {
        throw new TetherServerError(
          TetherServerErrorCode.NotFound,
          `Table "${tableName}" not found`,
        );
      }
      const user = userParam
        ? ((await ctx.storage.getUser(userParam)) ??
          (await ctx.storage.getUserByUserName(userParam)))
        : undefined;
      const records = await table.getAllRecords(user);
      sendJson(res, 200, records, ctx.corsConfig, req);
      return true;
    }

    if (method === 'POST') {
      const body = (await readJsonBody(req)) as {
        userId?: string;
        changes?: ChangeRecord[];
        table?: string;
        id?: string;
        data?: unknown;
        op?: OperationType;
      };
      const user = body.userId
        ? ((await ctx.storage.getUser(body.userId)) ??
          (await ctx.storage.getUserByUserName(body.userId)))
        : undefined;

      let changes = body.changes;
      if (!changes && body.table && body.id) {
        changes = [
          {
            table: body.table,
            id: body.id,
            op: body.op ?? OperationType.Put,
            data: body.data,
            timestamp: Date.now(),
            clientId: 'admin_cli',
          },
        ];
      }
      if (!changes) {
        throw new TetherServerError(
          TetherServerErrorCode.InvalidInput,
          'Either "changes" array or "table" and "id" must be provided',
        );
      }
      const result = await ctx.storage.applyChanges(user, changes);
      sendJson(res, 200, result, ctx.corsConfig, req);
      return true;
    }
  }

  return false;
}
