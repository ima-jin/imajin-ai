import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries, two bundles. src/react.ts must stay its own output file so
  // its 'use client' directive survives bundling as the first statement of
  // dist/react.js — merging it into dist/index.js would taint every
  // server-only import of the package (see src/react.ts for the full story).
  entry: ['src/index.ts', 'src/react.ts'],
  // ESM only. jose v6 dropped its CJS build entirely (exports only a
  // "default" webapi/ESM condition), and @noble/ed25519 ships no "exports"
  // map alongside "type": "module", so require() of either throws
  // ERR_REQUIRE_ESM. A CJS build here would resolve at install time and
  // then break at runtime for both dependencies.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // index.ts re-exports FairAccordion/FairEditor (.tsx). react is a peer
  // dependency, not bundled.
  jsx: 'automatic',
  external: ['react'],
});
