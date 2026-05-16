import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/handlers.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  external: ['next', 'next/headers', 'next/server', 'react'],
});
