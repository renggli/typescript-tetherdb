import { SqliteStorage } from 'tetherdb/server';
import { tetherPlugin } from 'tetherdb/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    tetherPlugin({
      storage: new SqliteStorage({ baseDir: './data' }),
      tables: ['todos'],
      users: [{ userName: 'demo', password: 'password123' }],
    }),
  ],
  server: {
    port: 3000,
  },
});
