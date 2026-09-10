import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // ESM only. react-markdown v10 is "type": "module" with a bare string
  // "exports" value (no "require" condition), so a CJS build would resolve
  // at install time and then throw ERR_REQUIRE_ESM the moment anything
  // actually executed the resulting dist/index.cjs.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Every exported symbol here is a 'use client' component/hook (see the
  // individual .tsx/.ts files); react is a peer dependency, not bundled.
  jsx: 'automatic',
  external: ['react'],
});
