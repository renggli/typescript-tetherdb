import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'client/index': 'src/client/index.ts',
    'server/index': 'src/server/index.ts',
    'server/tetherdb': 'src/server/tetherdb.ts',
    'shared/index': 'src/shared/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
});
