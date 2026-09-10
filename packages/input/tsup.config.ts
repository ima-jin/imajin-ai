import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // Dual ESM+CJS. @emoji-mart/react and @emoji-mart/data both ship a
  // genuine CommonJS "main" (no "type": "module", no "exports" map), so a
  // CJS build resolves cleanly downstream instead of throwing
  // ERR_REQUIRE_ESM. react is a runtime dependency here, not a peer, but
  // is still auto-externalized by tsup since it's listed under
  // "dependencies".
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  jsx: 'automatic',
});
