/**
 * TetherDB Vite Plugin — Zero-config local development and preview server integration.
 *
 * @module tetherdb/vite
 */

import type * as http from 'node:http';
import * as path from 'node:path';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';
import { TetherServer, type TetherServerOptions } from '../server/server.js';
import { MemoryStorage } from '../server/storage/memory.js';
import { StorageType } from '../server/storage/storage.js';
import {
  ANSI_BOLD,
  ANSI_COLOR_1,
  ANSI_DIM,
  ANSI_RESET,
} from '../shared/ansi.js';
import type { TableRow, TableSettings } from '../shared/types.js';

/**
 * Table declaration for automatic provisioning on startup.
 */
export interface TetherPluginTableDeclaration {
  /** Table name. */
  name: string;
  /** Optional table settings and permissions. */
  settings?: TableSettings;
  /** Optional initial rows to populate declaratively into the table. */
  rows?: TableRow[];
}

/**
 * User account declaration for automatic provisioning on startup.
 */
export interface TetherPluginUserDeclaration {
  /** Account username. */
  userName: string;
  /** Account password. */
  password: string;
}

/**
 * Options for configuring the TetherDB Vite plugin.
 */
export interface TetherPluginOptions extends TetherServerOptions {
  /** Tables to automatically declare on server startup. */
  tables?: Array<string | TetherPluginTableDeclaration>;
  /** Default user accounts to automatically declare or update on server startup. */
  users?: TetherPluginUserDeclaration[];
}

/**
 * Creates a Vite plugin that runs an embedded TetherDB synchronization and REST
 * authentication backend directly within the Vite dev and preview servers.
 *
 * @param options - Configuration options for storage, endpoints, tables, and users.
 * @returns Vite plugin object.
 */
export function tetherPlugin(options: TetherPluginOptions = {}): Plugin {
  let tetherServer: TetherServer | null = null;
  let isViteClosing = false;

  async function setupServer(
    server: ViteDevServer | PreviewServer,
  ): Promise<void> {
    tetherServer = new TetherServer({
      storage: options.storage ?? new MemoryStorage(),
      logger: options.logger ?? false,
      ...options,
      onClose: async () => {
        await options.onClose?.();
        if (!isViteClosing) {
          isViteClosing = true;
          try {
            (
              server.httpServer as unknown as {
                closeAllConnections?: () => void;
              }
            )?.closeAllConnections?.();
          } catch {
            // Ignore close errors
          }
          await server.close();
        }
      },
    });

    if (options.users) {
      for (const user of options.users) {
        await tetherServer.declareUser(user.userName, user.password);
      }
    }

    if (options.tables) {
      for (const table of options.tables) {
        if (typeof table === 'string') {
          await tetherServer.declareTable(table);
        } else {
          await tetherServer.declareTable(
            table.name,
            table.settings,
            table.rows ?? table.settings?.rows,
          );
        }
      }
    }

    if (server.httpServer) {
      tetherServer.attach(server.httpServer as unknown as http.Server);
      server.httpServer.on('close', () => {
        isViteClosing = true;
        tetherServer?.close().catch(() => {
          // Ignore close errors during server shutdown
        });
      });
    }

    const printTetherInfo = () => {
      const addr =
        typeof server.httpServer?.address === 'function'
          ? server.httpServer.address()
          : null;
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      const host =
        typeof addr === 'object' && addr && 'address' in addr
          ? (addr.address as string)
          : '127.0.0.1';
      const hostLabel =
        host === '0.0.0.0' || host === '::' ? 'localhost' : host;

      const storageType = tetherServer?.storage.type ?? StorageType.Memory;
      const baseDir = tetherServer?.storage.baseDir;

      const log = (msg: string) => {
        if (server.config?.logger?.info) {
          server.config.logger.info(msg);
        } else {
          console.log(msg);
        }
      };

      log(
        `  ${ANSI_COLOR_1}➜${ANSI_RESET}  ${ANSI_BOLD}Storage:${ANSI_RESET} ${ANSI_DIM}${storageType}${ANSI_RESET}`,
      );
      if (storageType === StorageType.Memory && tetherServer) {
        const adminToken = tetherServer.getAdminToken(
          hostLabel,
          port || undefined,
        );
        log(
          `     ${ANSI_BOLD}Admin Token:${ANSI_RESET} ${ANSI_DIM}${adminToken}${ANSI_RESET}`,
        );
      } else if (baseDir) {
        log(
          `     ${ANSI_BOLD}Directory:${ANSI_RESET} ${ANSI_DIM}${path.resolve(baseDir)}${ANSI_RESET}`,
        );
      }
    };

    if (typeof server.printUrls === 'function') {
      const originalPrintUrls = server.printUrls;
      server.printUrls = () => {
        originalPrintUrls.call(server);
        printTetherInfo();
      };
    }

    server.middlewares.use(tetherServer.createMiddleware());
  }

  return {
    name: 'vite-plugin-tetherdb',
    configureServer: setupServer,
    configurePreviewServer: setupServer,
    async closeBundle() {
      isViteClosing = true;
      if (tetherServer) {
        await tetherServer.close();
        tetherServer = null;
      }
    },
  };
}
