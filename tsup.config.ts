import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'client/index': 'src/client/index.ts',
    'server/cli': 'src/server/cli.ts',
    'server/index': 'src/server/index.ts',
    'shared/index': 'src/shared/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: true,
});
