import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    slowTestThreshold: 5000,
    server: {
      deps: {
        external: ['node:sqlite'],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/index.ts',
        'src/shared/types.ts',
        'src/server/storage/app.ts',
        'src/server/storage/storage.ts',
        'src/server/storage/table.ts',
        'src/server/storage/user.ts',
        'src/server/storage/index.ts',
        'src/**/*.d.ts',
      ],
      reporter: ['text', 'text-summary', 'json-summary', 'html', 'lcov'],
    },
  },
  ssr: {
    external: ['node:sqlite'],
  },
});
