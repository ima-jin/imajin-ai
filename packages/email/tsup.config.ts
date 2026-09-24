import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // Dual ESM+CJS. nodemailer and qrcode are plain CommonJS, and marked ships
  // a genuine "require" condition alongside "import" in its exports map, so
  // a CJS build resolves cleanly downstream instead of throwing
  // ERR_REQUIRE_ESM.
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
});
