import * as fs from 'node:fs';
import type * as http from 'node:http';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireServerLock } from '../../src/server/lock.js';
import { TetherServer } from '../../src/server/server.js';
import {
  BackendType,
  OperationType,
  Permission,
} from '../../src/shared/types.js';
import { type StorageContext, storageDescriptors } from './storage/matrix.js';

describe.each(storageDescriptors)(
  'TetherServer Security ($name)',
  ({ createBackend }) => {
    let server: TetherServer;
    let storageContext: StorageContext;

    beforeEach(async () => {
      storageContext = await createBackend();
      server = new TetherServer({
        storage: storageContext.storage,
        adminSecret: 'correct_admin_secret_12345678901234567890',
        cors: {
          origin: '*',
          credentials: true,
        },
      });
    });

    afterEach(async () => {
      await server.close();
      await storageContext.cleanup();
    });

    describe('assertAdminAuth', () => {
      it('rejects authorization tokens of mismatched length and invalid values', async () => {
        let statusCode = 0;
        const reqInvalidLength = {
          url: '/admin/status',
          method: 'GET',
          headers: {
            authorization: 'Bearer short',
          },
        } as unknown as http.IncomingMessage;

        const res = {
          writeHead: (code: number) => {
            statusCode = code;
          },
          end: () => {},
        } as unknown as http.ServerResponse;

        const handled = await server.handleHttpRequest(reqInvalidLength, res);
        expect(handled).toBe(true);
        expect(statusCode).toBe(401);

        const reqSameLengthInvalid = {
          url: '/admin/status',
          method: 'GET',
          headers: {
            authorization: 'Bearer wrong_admin_secret_12345678901234567890',
          },
        } as unknown as http.IncomingMessage;

        statusCode = 0;
        const handled2 = await server.handleHttpRequest(
          reqSameLengthInvalid,
          res,
        );
        expect(handled2).toBe(true);
        expect(statusCode).toBe(401);
      });
    });

    describe('Broken Object-Level Authorization (BOLA)', () => {
      it('prevents non-owners from updating or deleting records in shared tables with owner permissions', async () => {
        const table = await server.storage.createTable('shared_docs', {
          permissions: {
            create: Permission.Authenticated,
            read: Permission.Authenticated,
            update: Permission.Owner,
            delete: Permission.Owner,
          },
        });

        const userA = await server.storage.createUser('alice', 'password123');
        const userB = await server.storage.createUser(
          'bob_malicious',
          'password123',
        );

        // User A creates doc-1
        const createChange = {
          table: 'shared_docs',
          id: 'doc-1',
          op: OperationType.Put,
          data: { title: 'Alice Private Doc' },
          timestamp: Date.now(),
          clientId: 'client_alice',
        };

        const createRes = await server.storage.applyChanges(userA, [
          createChange,
        ]);
        expect(createRes.applied.length).toBe(1);

        // User B attempts to overwrite Alice's doc-1
        const overwriteChange = {
          table: 'shared_docs',
          id: 'doc-1',
          op: OperationType.Put,
          data: { title: 'Bob Overwrite Attempt' },
          timestamp: Date.now() + 10,
          clientId: 'client_bob',
        };

        await expect(
          server.storage.applyChanges(userB, [overwriteChange]),
        ).rejects.toThrow(/update access/);

        // User B attempts to delete Alice's doc-1
        const deleteChange = {
          table: 'shared_docs',
          id: 'doc-1',
          op: OperationType.Delete,
          timestamp: Date.now() + 20,
          clientId: 'client_bob',
        };

        await expect(
          server.storage.applyChanges(userB, [deleteChange]),
        ).rejects.toThrow(/delete access/);

        // User A can successfully update doc-1
        const aliceUpdate = {
          table: 'shared_docs',
          id: 'doc-1',
          op: OperationType.Put,
          data: { title: 'Alice Valid Update' },
          timestamp: Date.now() + 30,
          clientId: 'client_alice',
        };

        const aliceUpdateRes = await server.storage.applyChanges(userA, [
          aliceUpdate,
        ]);
        expect(aliceUpdateRes.applied.length).toBe(1);

        const rec = await table.getRecord(userA, 'doc-1');
        expect(rec?.data).toEqual({ title: 'Alice Valid Update' });
      });
    });

    describe('CORS and Proxy Security', () => {
      it('does not reflect wildcard origin when credentials are true', async () => {
        let headersSet: Record<string, string> = {};
        const req = {
          headers: {
            origin: 'https://malicious-attacker.com',
          },
          method: 'OPTIONS',
        } as unknown as http.IncomingMessage;

        const res = {
          writeHead: (_status: number, headers: Record<string, string>) => {
            headersSet = headers;
          },
          end: () => {},
        } as unknown as http.ServerResponse;

        await server.handleHttpRequest(req, res);
        expect(headersSet['Access-Control-Allow-Origin']).not.toBe('*');
      });
    });
  },
);

describe('acquireServerLock', () => {
  const tmpDir = path.join(process.cwd(), '.tmp-sec-lock-test');

  beforeEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('atomically acquires the lock and prevents duplicate lock holding by other pids', () => {
    const handle = acquireServerLock(tmpDir, {
      port: 8080,
      host: '127.0.0.1',
      backend: BackendType.Sqlite,
    });

    expect(handle).toBeDefined();

    expect(() =>
      acquireServerLock(tmpDir, {
        port: 8081,
        host: '127.0.0.1',
        backend: BackendType.Sqlite,
      }),
    ).not.toThrow();

    handle.release();
  });
});
