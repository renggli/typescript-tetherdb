import {
  FileStorage,
  Permission,
  PUBLIC_READ_PERMISSIONS,
} from 'tetherdb/server';
import { tetherPlugin } from 'tetherdb/vite';
import { defineConfig } from 'vite';
import { communityRows, forumUsers, postRows, voteRows } from './seed.js';

export default defineConfig({
  plugins: [
    tetherPlugin({
      storage: new FileStorage({ baseDir: './data' }),
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
            permissions: PUBLIC_READ_PERMISSIONS,
            rows: postRows,
          },
        },
        {
          name: 'votes',
          settings: {
            permissions: PUBLIC_READ_PERMISSIONS,
            rows: voteRows,
          },
        },
      ],
      users: forumUsers,
    }),
  ],
  server: {
    port: 3001,
  },
});
