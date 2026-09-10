import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // ESM only. @imajin/logger is itself ESM-only (see
  // packages/logger/tsup.config.ts), so a CJS build here would `require()`
  // fine at bundle time but throw ERR_REQUIRE_ESM the moment anything
  // actually executed the resulting dist/index.cjs and hit that import.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
