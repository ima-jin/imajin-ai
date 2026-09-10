import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // Dual ESM+CJS. react is the only runtime dependency, and it resolves
  // for require() too (its exports map's "default" condition covers
  // require, not just import), so a CJS build resolves cleanly downstream.
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  jsx: 'automatic',
});
