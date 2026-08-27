import { SqliteStorage } from 'tetherdb/server';
import { tetherPlugin } from 'tetherdb/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    tetherPlugin({
      storage: new SqliteStorage({
        baseDir: './data',
        maxRecords: 100000,
        maxHistoryEntries: 100000,
        maxRecordSizeBytes: 2 * 1024 * 1024,
        maxBatchSizeBytes: 20 * 1024 * 1024,
      }),
      tables: ['items', 'notes', 'todos', 'benchmarks'],
      users: [
        { username: 'demo', password: 'password123' },
        { username: 'admin', password: 'password123' },
      ],
    }),
  ],
  server: {
    port: 3001,
  },
});
