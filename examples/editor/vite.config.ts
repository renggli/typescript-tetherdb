import fs from 'node:fs';
import { MemoryStorage, Permission, type TableRow } from 'tetherdb/server';
import { tetherPlugin } from 'tetherdb/vite';
import { defineConfig } from 'vite';

interface DocumentLine {
  order: number;
  text: string;
}

const readmePath = new URL('./README.md', import.meta.url);
const initialDocument = fs.readFileSync(readmePath, 'utf-8');
const documentRows: TableRow<DocumentLine>[] = initialDocument
  .split('\n')
  .map((text, index) => ({
    id: `line_${String(index + 1).padStart(3, '0')}`,
    data: {
      order: (index + 1) * 100,
      text,
    },
  }));

export default defineConfig({
  plugins: [
    tetherPlugin({
      storage: new MemoryStorage(),
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
    port: 3000,
  },
});
