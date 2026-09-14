import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // ESM only. The package is `"type": "module"` and this is a CLI script
  // (`pnpm start` / `tsx src/index.ts`, see README — nothing in this repo
  // `require()`s it), so index.ts's top-level `await main()` (SonarCloud
  // typescript:S7785) can run as-is instead of a `.then/.catch` chain. A
  // CJS build was dropped rather than kept alongside it: top-level await
  // has no CommonJS equivalent, so esbuild refuses to emit a `cjs` bundle
  // for this entry at all once it contains one.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
