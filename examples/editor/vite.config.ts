import fs from 'node:fs';
import {
  MemoryStorage,
  PUBLIC_READ_WRITE_PERMISSIONS,
  type TableRow,
} from 'tetherdb/server';
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
            permissions: PUBLIC_READ_WRITE_PERMISSIONS,
            rows: documentRows,
          },
        },
        {
          name: 'presence',
          settings: {
            permissions: PUBLIC_READ_WRITE_PERMISSIONS,
          },
        },
      ],
    }),
  ],
  server: {
    port: 3000,
  },
});
