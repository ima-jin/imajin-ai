import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // ESM only. Every runtime dependency (multiformats, @ipld/dag-cbor) is
  // ESM-only and exposes no "require" condition, so a CJS build would resolve
  // at install time and then throw ERR_PACKAGE_PATH_NOT_EXPORTED on load.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
