import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.tsx'],
  // Dual ESM+CJS. react and react-dom are the only runtime dependencies
  // (both peers, externalized), and both resolve for require() too, so a
  // CJS build resolves cleanly downstream.
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  jsx: 'automatic',
});
