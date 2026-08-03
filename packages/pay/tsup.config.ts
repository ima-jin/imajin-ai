import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/providers/index.ts'],
  // Dual ESM+CJS. stripe, @solana/web3.js, and @solana/spl-token all ship
  // genuine require() support (real cjs/ builds behind proper exports
  // conditions, not just a fallback), so a CJS build resolves cleanly
  // downstream instead of throwing ERR_REQUIRE_ESM.
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
});
