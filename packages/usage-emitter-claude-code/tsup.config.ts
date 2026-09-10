import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // Dual ESM+CJS. No runtime dependencies at all (only Node built-ins), so
  // there's nothing that could throw ERR_REQUIRE_ESM downstream. index.ts's
  // `#!/usr/bin/env node` shebang is preserved by tsup, and its
  // `import.meta.url` self-invocation guard is polyfilled by esbuild for
  // the CJS output.
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
});
