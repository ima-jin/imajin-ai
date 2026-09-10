import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // ESM only. @imajin/auth is itself ESM-only (see packages/auth/tsup.config.ts),
  // and @metalabel/dfos-protocol is "type": "module" with no "require"
  // condition either. A CJS build here would `require()` fine at bundle time
  // but throw ERR_REQUIRE_ESM the moment anything actually executed the
  // resulting dist/index.cjs.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
