import { Permission, SqliteStorage } from 'tetherdb/server';
import { tetherPlugin } from 'tetherdb/vite';
import { defineConfig } from 'vite';
import { communityRows, forumUsers, postRows, voteRows } from './seed.js';

export default defineConfig({
  plugins: [
    tetherPlugin({
      storage: new SqliteStorage({ baseDir: './data' }),
      tables: [
        {
          name: 'communities',
          settings: {
            permissions: {
              read: Permission.Everybody,
              create: Permission.Nobody,
              update: Permission.Nobody,
              delete: Permission.Nobody,
            },
            rows: communityRows,
          },
        },
        {
          name: 'posts',
          settings: {
            permissions: {
              read: Permission.Everybody,
              create: Permission.Authenticated,
              update: Permission.Owner,
              delete: Permission.Owner,
            },
            rows: postRows,
          },
        },
        {
          name: 'votes',
          settings: {
            permissions: {
              read: Permission.Everybody,
              create: Permission.Authenticated,
              update: Permission.Owner,
              delete: Permission.Owner,
            },
            rows: voteRows,
          },
        },
      ],
      users: forumUsers,
    }),
  ],
  server: {
    port: 3002,
  },
});
