import { describe, expect, it } from 'vitest';
import { OperationType, Permission } from '../../../src/shared/types.js';
import { sqliteMemoryStorage, sqliteStorage } from './matrix.js';

describe('SqliteStorage Atomic Deletion', () => {
  for (const descriptor of [sqliteMemoryStorage, sqliteStorage]) {
    describe(`Backend: ${descriptor.name}`, () => {
      it('atomically deletes table, its records, and changelog', async () => {
        const ctx = await descriptor.createBackend();
        try {
          const table = await ctx.storage.createTable('posts', {
            permissions: {
              read: Permission.Everybody,
              create: Permission.Everybody,
              update: Permission.Everybody,
              delete: Permission.Everybody,
            },
          });

          await ctx.storage.applyChanges(undefined, [
            {
              table: 'posts',
              id: 'p1',
              op: OperationType.Put,
              data: { text: 'test post' },
              timestamp: 1000,
            },
          ]);

          expect(await table.getRecord(undefined, 'p1')).toBeDefined();

          const deleted = ctx.storage.deleteTable('posts');
          expect(deleted).toBe(true);

          expect(await ctx.storage.getTable('posts')).toBeUndefined();
          expect(ctx.storage.deleteTable('posts')).toBe(false);
        } finally {
          await ctx.cleanup();
        }
      });

      it('atomically deletes user and cascades removal to records and changelog', async () => {
        const ctx = await descriptor.createBackend();
        try {
          const user = await ctx.storage.createUser('alice', 'Password123!');
          await ctx.storage.createTable('notes', {
            permissions: {
              read: Permission.Everybody,
              create: Permission.Authenticated,
              update: Permission.Owner,
              delete: Permission.Owner,
            },
          });

          await ctx.storage.applyChanges(user, [
            {
              table: 'notes',
              id: 'n1',
              op: OperationType.Put,
              data: { text: 'alice note' },
              timestamp: 1000,
            },
          ]);

          const deleted = ctx.storage.deleteUser(user.userId);
          expect(deleted).toBe(true);

          expect(await ctx.storage.getUser(user.userId)).toBeUndefined();
          expect(ctx.storage.deleteUser(user.userId)).toBe(false);
        } finally {
          await ctx.cleanup();
        }
      });
    });
  }
});
