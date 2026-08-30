import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TetherServerErrorCode } from '../../../src/server/errors.js';
import type { Storage } from '../../../src/server/storage/storage.js';
import type { User } from '../../../src/server/storage/user.js';
import {
  type ChangeRecord,
  OperationType,
  Permission,
  PUBLIC_READ_PERMISSIONS,
  PUBLIC_READ_WRITE_PERMISSIONS,
  SHARED_PERMISSIONS,
  USER_PRIVATE_PERMISSIONS,
} from '../../../src/shared/types.js';
import { type StorageContext, storageDescriptors } from './matrix.js';

describe.each(storageDescriptors)(
  'Storage Permissions ($name)',
  ({ createBackend }) => {
    let context: StorageContext;
    let storage: Storage;
    let userAlice: User;
    let userBob: User;

    beforeEach(async () => {
      context = await createBackend();
      storage = context.backend;
      userAlice = await storage.createUser('alice', 'alice-pass');
      userBob = await storage.createUser('bob', 'bob-pass');
    });

    afterEach(async () => {
      await context.cleanup();
    });

    describe('CREATE Permission Enforcement', () => {
      it('should reject creation when create is Permission.Nobody', async () => {
        const table = await storage.createTable('read_only_table', {
          permissions: {
            create: Permission.Nobody,
            read: Permission.Everybody,
            update: Permission.Nobody,
            delete: Permission.Nobody,
          },
        });

        const change: ChangeRecord = {
          table: 'read_only_table',
          id: 'rec-1',
          op: OperationType.Put,
          data: { value: 'forbidden' },
          timestamp: 1000,
          clientId: 'c1',
        };

        // Authenticated user fails
        await expect(
          storage.applyChanges(userAlice, [change]),
        ).rejects.toMatchObject({
          code: TetherServerErrorCode.Forbidden,
        });

        // Guest fails
        await expect(
          storage.applyChanges(undefined, [change]),
        ).rejects.toMatchObject({
          code: TetherServerErrorCode.Forbidden,
        });

        // Data was not created
        expect(await table.getRecord(userAlice, 'rec-1')).toBeUndefined();
        expect(await table.getAllRecords(userAlice)).toHaveLength(0);
      });

      it('should allow authenticated users and reject guests when create is Permission.Authenticated', async () => {
        const table = await storage.createTable('auth_create_table', {
          permissions: {
            create: Permission.Authenticated,
            read: Permission.Everybody,
            update: Permission.Owner,
            delete: Permission.Owner,
          },
        });

        const guestChange: ChangeRecord = {
          table: 'auth_create_table',
          id: 'guest-rec',
          op: OperationType.Put,
          data: { value: 'guest payload' },
          timestamp: 1000,
          clientId: 'c1',
        };

        // Guest fails
        await expect(
          storage.applyChanges(undefined, [guestChange]),
        ).rejects.toMatchObject({
          code: TetherServerErrorCode.Forbidden,
        });

        // Alice succeeds
        const aliceChange: ChangeRecord = {
          table: 'auth_create_table',
          id: 'alice-rec',
          op: OperationType.Put,
          data: { value: 'alice payload' },
          timestamp: 1001,
          clientId: 'c1',
        };
        const res = await storage.applyChanges(userAlice, [aliceChange]);
        expect(res.applied).toHaveLength(1);

        const record = await table.getRecord(userAlice, 'alice-rec');
        expect(record?.data).toEqual({ value: 'alice payload' });
      });

      it('should allow guests and authenticated users when create is Permission.Everybody', async () => {
        const table = await storage.createTable('open_create_table', {
          permissions: {
            create: Permission.Everybody,
            read: Permission.Everybody,
            update: Permission.Everybody,
            delete: Permission.Everybody,
          },
        });

        // Guest creates record
        const guestChange: ChangeRecord = {
          table: 'open_create_table',
          id: 'guest-rec',
          op: OperationType.Put,
          data: { creator: 'guest' },
          timestamp: 1000,
          clientId: 'c1',
        };
        await storage.applyChanges(undefined, [guestChange]);

        // Alice creates record
        const aliceChange: ChangeRecord = {
          table: 'open_create_table',
          id: 'alice-rec',
          op: OperationType.Put,
          data: { creator: 'alice' },
          timestamp: 1001,
          clientId: 'c1',
        };
        await storage.applyChanges(userAlice, [aliceChange]);

        expect(await table.getRecord(undefined, 'guest-rec')).toBeDefined();
        expect(await table.getRecord(userAlice, 'alice-rec')).toBeDefined();
        expect(await table.getAllRecords(undefined)).toHaveLength(2);
      });
    });

    describe('READ Permission Enforcement & Data Isolation', () => {
      it('should prevent all reads when read is Permission.Nobody', async () => {
        const table = await storage.createTable('nobody_read_table', {
          permissions: {
            create: Permission.Authenticated,
            read: Permission.Nobody,
            update: Permission.Nobody,
            delete: Permission.Nobody,
          },
        });

        // Insert record via skipPermissionCheck
        await storage.applyChanges(
          userAlice,
          [
            {
              table: 'nobody_read_table',
              id: 'secret-1',
              op: OperationType.Put,
              data: { classified: true },
              timestamp: 1000,
              clientId: 'c1',
            },
          ],
          { skipPermissionCheck: true },
        );

        // Alice cannot read
        expect(await table.getRecord(userAlice, 'secret-1')).toBeUndefined();
        expect(await table.getAllRecords(userAlice)).toHaveLength(0);

        // Bob cannot read
        expect(await table.getRecord(userBob, 'secret-1')).toBeUndefined();
        expect(await table.getAllRecords(userBob)).toHaveLength(0);

        // Guest cannot read
        expect(await table.getRecord(undefined, 'secret-1')).toBeUndefined();
        expect(await table.getAllRecords(undefined)).toHaveLength(0);

        // getChangesSince returns no changes
        const diff = await storage.getChangesSince(userAlice, 0);
        expect(
          diff.changes.filter((c) => c.table === 'nobody_read_table'),
        ).toHaveLength(0);
      });

      it('should strictly isolate data per-user on Permission.Owner (user-private)', async () => {
        const table = await storage.createTable('private_notes', {
          permissions: USER_PRIVATE_PERMISSIONS,
        });

        // Alice writes her private note
        await storage.applyChanges(userAlice, [
          {
            table: 'private_notes',
            id: 'note-1',
            op: OperationType.Put,
            data: { text: "Alice's Diary" },
            timestamp: 1000,
            clientId: 'c-alice',
          },
        ]);

        // Bob writes his private note
        await storage.applyChanges(userBob, [
          {
            table: 'private_notes',
            id: 'note-2',
            op: OperationType.Put,
            data: { text: "Bob's Diary" },
            timestamp: 1000,
            clientId: 'c-bob',
          },
        ]);

        // Alice reads: sees only note-1
        expect(await table.getRecord(userAlice, 'note-1')).toBeDefined();
        expect(await table.getRecord(userAlice, 'note-2')).toBeUndefined();
        const aliceAll = await table.getAllRecords(userAlice);
        expect(aliceAll).toHaveLength(1);
        expect(aliceAll[0].id).toBe('note-1');

        // Bob reads: sees only note-2
        expect(await table.getRecord(userBob, 'note-2')).toBeDefined();
        expect(await table.getRecord(userBob, 'note-1')).toBeUndefined();
        const bobAll = await table.getAllRecords(userBob);
        expect(bobAll).toHaveLength(1);
        expect(bobAll[0].id).toBe('note-2');

        // Guest reads: sees nothing
        expect(await table.getRecord(undefined, 'note-1')).toBeUndefined();
        expect(await table.getRecord(undefined, 'note-2')).toBeUndefined();
        expect(await table.getAllRecords(undefined)).toHaveLength(0);

        // Changelog isolation: incremental diffs from seq 1
        const aliceDiff = await storage.getChangesSince(userAlice, 1);
        expect(aliceDiff.changes.map((c) => c.id)).not.toContain('note-2');

        const bobDiff = await storage.getChangesSince(userBob, 1);
        expect(bobDiff.changes.map((c) => c.id)).not.toContain('note-1');
      });

      it('should allow all authenticated users but block guests when read is Permission.Authenticated (shared)', async () => {
        const table = await storage.createTable('shared_tasks', {
          permissions: SHARED_PERMISSIONS,
        });

        // Alice creates first task (seq 1)
        await storage.applyChanges(userAlice, [
          {
            table: 'shared_tasks',
            id: 'task-1',
            op: OperationType.Put,
            data: { title: 'Team task 1' },
            timestamp: 1000,
            clientId: 'c1',
          },
        ]);

        // Alice creates second task (seq 2)
        await storage.applyChanges(userAlice, [
          {
            table: 'shared_tasks',
            id: 'task-2',
            op: OperationType.Put,
            data: { title: 'Team task 2' },
            timestamp: 1001,
            clientId: 'c1',
          },
        ]);

        // Alice can read
        expect(await table.getRecord(userAlice, 'task-1')).toBeDefined();
        expect(await table.getAllRecords(userAlice)).toHaveLength(2);

        // Bob can read
        expect(await table.getRecord(userBob, 'task-1')).toBeDefined();
        expect(await table.getAllRecords(userBob)).toHaveLength(2);

        // Guest CANNOT read
        expect(await table.getRecord(undefined, 'task-1')).toBeUndefined();
        expect(await table.getAllRecords(undefined)).toHaveLength(0);

        // Bob receives subsequent change from seq 1
        const bobDiff = await storage.getChangesSince(userBob, 1);
        expect(bobDiff.changes.some((c) => c.id === 'task-2')).toBe(true);

        // Guest receives no changes in changelog
        const guestDiff = await storage.getChangesSince(undefined, 1);
        expect(guestDiff.changes.some((c) => c.id === 'task-2')).toBe(false);
      });

      it('should allow everyone including guests when read is Permission.Everybody (public-read)', async () => {
        const table = await storage.createTable('public_announcements', {
          permissions: PUBLIC_READ_PERMISSIONS,
        });

        await storage.applyChanges(userAlice, [
          {
            table: 'public_announcements',
            id: 'news-1',
            op: OperationType.Put,
            data: { title: 'Welcome 1' },
            timestamp: 1000,
            clientId: 'c1',
          },
          {
            table: 'public_announcements',
            id: 'news-2',
            op: OperationType.Put,
            data: { title: 'Welcome 2' },
            timestamp: 1001,
            clientId: 'c1',
          },
        ]);

        // Alice, Bob, and Guest all see the record
        expect(await table.getRecord(userAlice, 'news-1')).toBeDefined();
        expect(await table.getRecord(userBob, 'news-1')).toBeDefined();
        expect(await table.getRecord(undefined, 'news-1')).toBeDefined();

        expect(await table.getAllRecords(undefined)).toHaveLength(2);
        const guestDiff = await storage.getChangesSince(undefined, 1);
        expect(guestDiff.changes.some((c) => c.id === 'news-2')).toBe(true);
      });
    });

    describe('UPDATE Permission Enforcement', () => {
      it('should reject updates when update is Permission.Nobody (append-only)', async () => {
        const table = await storage.createTable('audit_log', {
          permissions: {
            create: Permission.Authenticated,
            read: Permission.Authenticated,
            update: Permission.Nobody,
            delete: Permission.Nobody,
          },
        });

        // Alice creates an initial record
        await storage.applyChanges(userAlice, [
          {
            table: 'audit_log',
            id: 'log-1',
            op: OperationType.Put,
            data: { event: 'Login', original: true },
            timestamp: 1000,
            clientId: 'c1',
          },
        ]);

        // Alice attempts to update her own record -> fails
        await expect(
          storage.applyChanges(userAlice, [
            {
              table: 'audit_log',
              id: 'log-1',
              op: OperationType.Put,
              data: { event: 'Tampered' },
              timestamp: 2000,
              clientId: 'c1',
            },
          ]),
        ).rejects.toMatchObject({
          code: TetherServerErrorCode.Forbidden,
        });

        // Bob attempts to update Alice's record -> fails
        await expect(
          storage.applyChanges(userBob, [
            {
              table: 'audit_log',
              id: 'log-1',
              op: OperationType.Put,
              data: { event: 'Tampered by Bob' },
              timestamp: 2000,
              clientId: 'c2',
            },
          ]),
        ).rejects.toMatchObject({
          code: TetherServerErrorCode.Forbidden,
        });

        // Record is intact
        const record = await table.getRecord(userAlice, 'log-1');
        expect(record?.data).toEqual({ event: 'Login', original: true });
      });

      it('should restrict updates to record creator when update is Permission.Owner', async () => {
        const table = await storage.createTable('forum_posts', {
          permissions: PUBLIC_READ_PERMISSIONS, // read: Everybody, create: Authenticated, update: Owner, delete: Owner
        });

        // Alice creates a post
        await storage.applyChanges(userAlice, [
          {
            table: 'forum_posts',
            id: 'post-1',
            op: OperationType.Put,
            data: { body: 'Original post by Alice' },
            timestamp: 1000,
            clientId: 'c-alice',
          },
        ]);

        // Bob attempts to edit Alice's post -> rejected
        await expect(
          storage.applyChanges(userBob, [
            {
              table: 'forum_posts',
              id: 'post-1',
              op: OperationType.Put,
              data: { body: 'Hijacked by Bob' },
              timestamp: 2000,
              clientId: 'c-bob',
            },
          ]),
        ).rejects.toMatchObject({
          code: TetherServerErrorCode.Forbidden,
        });

        // Guest attempts to edit Alice's post -> rejected
        await expect(
          storage.applyChanges(undefined, [
            {
              table: 'forum_posts',
              id: 'post-1',
              op: OperationType.Put,
              data: { body: 'Hijacked by Guest' },
              timestamp: 2000,
              clientId: 'c-guest',
            },
          ]),
        ).rejects.toMatchObject({
          code: TetherServerErrorCode.Forbidden,
        });

        // Post remains unchanged
        let record = await table.getRecord(userAlice, 'post-1');
        expect(record?.data).toEqual({ body: 'Original post by Alice' });

        // Alice edits her own post -> succeeds
        await storage.applyChanges(userAlice, [
          {
            table: 'forum_posts',
            id: 'post-1',
            op: OperationType.Put,
            data: { body: 'Updated post by Alice' },
            timestamp: 2000,
            clientId: 'c-alice',
          },
        ]);

        record = await table.getRecord(userAlice, 'post-1');
        expect(record?.data).toEqual({ body: 'Updated post by Alice' });
      });

      it('should allow any authenticated user to update when update is Permission.Authenticated', async () => {
        const table = await storage.createTable('collaborative_wiki', {
          permissions: {
            create: Permission.Authenticated,
            read: Permission.Authenticated,
            update: Permission.Authenticated,
            delete: Permission.Owner,
          },
        });

        // Alice creates article
        await storage.applyChanges(userAlice, [
          {
            table: 'collaborative_wiki',
            id: 'article-1',
            op: OperationType.Put,
            data: { content: 'Version 1 by Alice' },
            timestamp: 1000,
            clientId: 'c1',
          },
        ]);

        // Bob updates article -> succeeds
        await storage.applyChanges(userBob, [
          {
            table: 'collaborative_wiki',
            id: 'article-1',
            op: OperationType.Put,
            data: { content: 'Version 2 edited by Bob' },
            timestamp: 2000,
            clientId: 'c2',
          },
        ]);

        // Guest attempts update -> fails
        await expect(
          storage.applyChanges(undefined, [
            {
              table: 'collaborative_wiki',
              id: 'article-1',
              op: OperationType.Put,
              data: { content: 'Vandalized by Guest' },
              timestamp: 3000,
              clientId: 'c3',
            },
          ]),
        ).rejects.toMatchObject({
          code: TetherServerErrorCode.Forbidden,
        });

        const record = await table.getRecord(userAlice, 'article-1');
        expect(record?.data).toEqual({ content: 'Version 2 edited by Bob' });
      });

      it('should allow anyone to update when update is Permission.Everybody', async () => {
        const table = await storage.createTable('shared_scratchpad', {
          permissions: PUBLIC_READ_WRITE_PERMISSIONS,
        });

        // Alice creates
        await storage.applyChanges(userAlice, [
          {
            table: 'shared_scratchpad',
            id: 'pad-1',
            op: OperationType.Put,
            data: { text: 'Hello' },
            timestamp: 1000,
            clientId: 'c1',
          },
        ]);

        // Guest updates
        await storage.applyChanges(undefined, [
          {
            table: 'shared_scratchpad',
            id: 'pad-1',
            op: OperationType.Put,
            data: { text: 'Hello from guest' },
            timestamp: 2000,
            clientId: 'c2',
          },
        ]);

        const record = await table.getRecord(undefined, 'pad-1');
        expect(record?.data).toEqual({ text: 'Hello from guest' });
      });
    });

    describe('DELETE Permission Enforcement', () => {
      it('should reject deletion when delete is Permission.Nobody', async () => {
        const table = await storage.createTable('permanent_archive', {
          permissions: {
            create: Permission.Authenticated,
            read: Permission.Authenticated,
            update: Permission.Owner,
            delete: Permission.Nobody,
          },
        });

        await storage.applyChanges(userAlice, [
          {
            table: 'permanent_archive',
            id: 'arch-1',
            op: OperationType.Put,
            data: { text: 'Immutable Record' },
            timestamp: 1000,
            clientId: 'c1',
          },
        ]);

        // Alice attempts to delete her own record -> rejected
        await expect(
          storage.applyChanges(userAlice, [
            {
              table: 'permanent_archive',
              id: 'arch-1',
              op: OperationType.Delete,
              timestamp: 2000,
              clientId: 'c1',
            },
          ]),
        ).rejects.toMatchObject({
          code: TetherServerErrorCode.Forbidden,
        });

        // Bob attempts delete -> rejected
        await expect(
          storage.applyChanges(userBob, [
            {
              table: 'permanent_archive',
              id: 'arch-1',
              op: OperationType.Delete,
              timestamp: 2000,
              clientId: 'c2',
            },
          ]),
        ).rejects.toMatchObject({
          code: TetherServerErrorCode.Forbidden,
        });

        expect(await table.getRecord(userAlice, 'arch-1')).toBeDefined();
      });

      it('should restrict deletion to record creator when delete is Permission.Owner', async () => {
        const table = await storage.createTable('discussions', {
          permissions: SHARED_PERMISSIONS, // read: Authenticated, create: Authenticated, update: Owner, delete: Owner
        });

        await storage.applyChanges(userAlice, [
          {
            table: 'discussions',
            id: 'topic-1',
            op: OperationType.Put,
            data: { title: "Alice's Topic" },
            timestamp: 1000,
            clientId: 'c1',
          },
        ]);

        // Bob attempts to delete Alice's topic -> rejected
        await expect(
          storage.applyChanges(userBob, [
            {
              table: 'discussions',
              id: 'topic-1',
              op: OperationType.Delete,
              timestamp: 2000,
              clientId: 'c2',
            },
          ]),
        ).rejects.toMatchObject({
          code: TetherServerErrorCode.Forbidden,
        });

        // Guest attempts to delete -> rejected
        await expect(
          storage.applyChanges(undefined, [
            {
              table: 'discussions',
              id: 'topic-1',
              op: OperationType.Delete,
              timestamp: 2000,
              clientId: 'c3',
            },
          ]),
        ).rejects.toMatchObject({
          code: TetherServerErrorCode.Forbidden,
        });

        // Topic remains present
        expect(await table.getRecord(userAlice, 'topic-1')).toBeDefined();

        // Alice deletes her own topic -> succeeds
        await storage.applyChanges(userAlice, [
          {
            table: 'discussions',
            id: 'topic-1',
            op: OperationType.Delete,
            timestamp: 2000,
            clientId: 'c1',
          },
        ]);

        expect(await table.getRecord(userAlice, 'topic-1')).toBeUndefined();
      });

      it('should allow any authenticated user to delete when delete is Permission.Authenticated', async () => {
        const table = await storage.createTable('moderated_chat', {
          permissions: {
            create: Permission.Authenticated,
            read: Permission.Authenticated,
            update: Permission.Owner,
            delete: Permission.Authenticated,
          },
        });

        await storage.applyChanges(userAlice, [
          {
            table: 'moderated_chat',
            id: 'msg-1',
            op: OperationType.Put,
            data: { message: 'Spam msg' },
            timestamp: 1000,
            clientId: 'c1',
          },
        ]);

        // Guest cannot delete
        await expect(
          storage.applyChanges(undefined, [
            {
              table: 'moderated_chat',
              id: 'msg-1',
              op: OperationType.Delete,
              timestamp: 2000,
              clientId: 'cg',
            },
          ]),
        ).rejects.toMatchObject({
          code: TetherServerErrorCode.Forbidden,
        });

        // Bob deletes Alice's message -> succeeds
        await storage.applyChanges(userBob, [
          {
            table: 'moderated_chat',
            id: 'msg-1',
            op: OperationType.Delete,
            timestamp: 2000,
            clientId: 'c2',
          },
        ]);

        expect(await table.getRecord(userAlice, 'msg-1')).toBeUndefined();
      });

      it('should allow anyone to delete when delete is Permission.Everybody', async () => {
        const table = await storage.createTable('temp_sandbox', {
          permissions: PUBLIC_READ_WRITE_PERMISSIONS,
        });

        await storage.applyChanges(userAlice, [
          {
            table: 'temp_sandbox',
            id: 'tmp-1',
            op: OperationType.Put,
            data: { val: 'test' },
            timestamp: 1000,
            clientId: 'c1',
          },
        ]);

        // Guest deletes
        await storage.applyChanges(undefined, [
          {
            table: 'temp_sandbox',
            id: 'tmp-1',
            op: OperationType.Delete,
            timestamp: 2000,
            clientId: 'cg',
          },
        ]);

        expect(await table.getRecord(undefined, 'tmp-1')).toBeUndefined();
      });
    });
  },
);
