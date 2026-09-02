import { describe, expect, it } from 'vitest';
import { TetherServerError } from '../../../src/server/errors.js';
import { OperationType, Permission } from '../../../src/shared/types.js';
import { storageDescriptors } from './matrix.js';

describe('Tombstone Resurrection Ownership', () => {
  for (const descriptor of storageDescriptors) {
    describe(`Backend: ${descriptor.name}`, () => {
      it('assigns new creator userId on tombstone resurrection and denies previous owner', async () => {
        const ctx = await descriptor.createBackend();
        try {
          const user1 = await ctx.storage.createUser('alice', 'Password123!');
          const user2 = await ctx.storage.createUser('bob', 'Password123!');

          const table = await ctx.storage.createTable('articles', {
            permissions: {
              read: Permission.Everybody,
              create: Permission.Authenticated,
              update: Permission.Owner,
              delete: Permission.Owner,
            },
          });

          // 1. Alice creates article-1
          await ctx.storage.applyChanges(user1, [
            {
              table: table.name,
              id: 'art-1',
              op: OperationType.Put,
              data: { title: 'Alice Post' },
              timestamp: 1000,
            },
          ]);

          // 2. Alice deletes article-1
          await ctx.storage.applyChanges(user1, [
            {
              table: table.name,
              id: 'art-1',
              op: OperationType.Delete,
              timestamp: 2000,
            },
          ]);

          // 3. Bob resurrects article-1
          await ctx.storage.applyChanges(user2, [
            {
              table: table.name,
              id: 'art-1',
              op: OperationType.Put,
              data: { title: 'Bob Post' },
              timestamp: 3000,
            },
          ]);

          // Verify Bob is the owner
          const record = await table.getRecord(undefined, 'art-1');
          expect(record?.userName).toBe('bob');
          expect(record?.data).toEqual({ title: 'Bob Post' });

          // Bob can update his resurrected record
          await expect(
            ctx.storage.applyChanges(user2, [
              {
                table: table.name,
                id: 'art-1',
                op: OperationType.Put,
                data: { title: 'Bob Updated Post' },
                timestamp: 4000,
              },
            ]),
          ).resolves.toBeDefined();

          // Alice cannot update Bob's record (Forbidden)
          await expect(
            ctx.storage.applyChanges(user1, [
              {
                table: table.name,
                id: 'art-1',
                op: OperationType.Put,
                data: { title: 'Alice Hijack' },
                timestamp: 5000,
              },
            ]),
          ).rejects.toThrow(TetherServerError);

          // Alice cannot delete Bob's record (Forbidden)
          await expect(
            ctx.storage.applyChanges(user1, [
              {
                table: table.name,
                id: 'art-1',
                op: OperationType.Delete,
                timestamp: 6000,
              },
            ]),
          ).rejects.toThrow(TetherServerError);
        } finally {
          await ctx.cleanup();
        }
      });
    });
  }
});
