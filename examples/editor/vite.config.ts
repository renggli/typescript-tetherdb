import { Permission } from 'tetherdb/server';
import { tetherPlugin } from 'tetherdb/vite';
import { defineConfig } from 'vite';
import { documentRows } from './seed.js';

export default defineConfig({
  plugins: [
    tetherPlugin({
      tables: [
        {
          name: 'document',
          settings: {
            permissions: {
              read: Permission.Everybody,
              create: Permission.Everybody,
              update: Permission.Everybody,
              delete: Permission.Everybody,
            },
            rows: documentRows,
          },
        },
        {
          name: 'presence',
          settings: {
            permissions: {
              read: Permission.Everybody,
              create: Permission.Everybody,
              update: Permission.Everybody,
              delete: Permission.Everybody,
            },
          },
        },
      ],
    }),
  ],
  server: {
    port: 3004,
  },
});
