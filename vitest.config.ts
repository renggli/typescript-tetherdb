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
  },
  ssr: {
    external: ['node:sqlite'],
  },
});
