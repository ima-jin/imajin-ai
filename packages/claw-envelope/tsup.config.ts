import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries: the library surface (index.ts) and the `claw-envelope` bin
  // (cli.ts, referenced by the "bin" field in package.json). tsup preserves
  // cli.ts's `#!/usr/bin/env node` shebang and marks dist/cli.js executable.
  entry: ['src/index.ts', 'src/cli.ts'],
  // ESM only. @imajin/auth is itself ESM-only (see packages/auth/tsup.config.ts),
  // so a CJS build here would `require()` fine at bundle time but throw
  // ERR_REQUIRE_ESM the moment anything actually executed the resulting
  // dist/*.cjs and hit that import.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
