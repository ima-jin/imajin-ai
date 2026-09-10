import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // ESM only. bus's own workspace dependencies (@imajin/auth, @imajin/logger,
  // @imajin/fair, @imajin/emit, @imajin/notify) are themselves ESM-only —
  // each ultimately resolves to a "type": "module" package with no "require"
  // condition, so a CJS build here would `require()` fine at bundle time but
  // throw ERR_REQUIRE_ESM the moment anything actually executed the
  // resulting dist/index.cjs and hit one of those imports.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
