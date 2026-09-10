import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // Dual ESM+CJS, matching packages/db (which trust-graph depends on).
  // Both of its other runtime deps expose a genuine `require` resolution:
  // postgres ships a real cjs/ build behind its `default` export condition,
  // and drizzle-orm ships matching .cjs/.d.cts files for every entry point.
  // A CJS build resolves cleanly downstream instead of throwing
  // ERR_REQUIRE_ESM, so this is an honest dual build, not a forced one.
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
});
