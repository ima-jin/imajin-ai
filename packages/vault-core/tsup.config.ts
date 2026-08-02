import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // ESM only — see packages/cid/tsup.config.ts. @noble/ed25519 and the cid
  // dependency chain are all ESM-only, and bundling private copies of the
  // crypto to fake a CJS build would defeat the point of a shared vault-core.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
