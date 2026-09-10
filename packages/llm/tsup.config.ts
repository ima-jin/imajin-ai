import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // Dual ESM+CJS. ai, @ai-sdk/anthropic, @ai-sdk/openai, and zod all ship
  // genuine "require" conditions alongside "import" in their exports maps,
  // so a CJS build resolves cleanly downstream instead of throwing
  // ERR_REQUIRE_ESM.
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
});
