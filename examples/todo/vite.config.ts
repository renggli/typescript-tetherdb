import { SqliteStorage } from 'tetherdb/server';
import { tetherPlugin } from 'tetherdb/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    tetherPlugin({
      storage: new SqliteStorage({ baseDir: './data' }),
      tables: ['todos'],
    }),
  ],
  server: {
    port: 3002,
  },
});
