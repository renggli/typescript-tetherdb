import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    server: {
      deps: {
        external: ['node:sqlite'],
      },
    },
  },
  ssr: {
    external: ['node:sqlite'],
  },
});
