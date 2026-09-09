import { defineConfig } from 'tsup';

export default defineConfig({
  // One bundle per exports-map entry. broker-consent-vocabulary/scope-vocabulary/
  // grant-scopes are imported standalone (e.g. client components, connector
  // manifests) precisely to stay out of the server-only index bundle — see the
  // comment above the scope-vocabulary re-export in src/index.ts.
  entry: [
    'src/index.ts',
    'src/broker-consent-vocabulary.ts',
    'src/scope-vocabulary.ts',
    'src/grant-scopes.ts',
  ],
  // ESM only. @noble/curves, @noble/ed25519, and @noble/hashes are all
  // "type": "module" with no "require" condition in their exports map, so a
  // CJS build would resolve at install time and then throw ERR_REQUIRE_ESM
  // the moment anything actually executed the resulting dist/*.cjs.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // drizzle-orm is a devDependency (not a runtime "dependency"), so tsup
  // doesn't externalize it by default — but src/resolve.ts dynamically
  // imports it purely to construct an `eq()` condition against a *caller*-
  // supplied Drizzle table/db (see createDbResolver). Bundling a private
  // copy would give that condition a different SQL/Column class identity
  // than the consuming app's own drizzle-orm instance, which drizzle's
  // internal `is()`/instanceof checks rely on to recognize it. Keeping it
  // external ensures the dynamic import resolves the same module instance
  // the caller already has installed.
  external: ['drizzle-orm'],
});
