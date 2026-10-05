import { defineConfig } from 'tsup';

/**
 * Compiles `scripts/lib/provision-service-bootstrap.ts` — and the repo-local
 * kernel TypeScript it imports (`apps/kernel/src/**`, via the kernel's `@/…`
 * tsconfig path alias) — to ONE native ES module, `dist/index.mjs`, as part of
 * the normal `pnpm -r --filter './packages/**' build` the deploy already runs
 * (#2485). `scripts/provision-service-bootstrap.mjs` then just `import()`s it:
 * nothing is bundled at deploy time.
 *
 * Why a build step at all: the kernel is a typeless (CommonJS) package whose
 * sources use `@/…` aliases and extensionless relative imports, which Node
 * can't load natively, and which tsx would compile to CommonJS — where
 * ESM-only dependencies (`@ipld/dag-cbor`) fail with `No "exports" main
 * defined` (#2483).
 *
 * Only repo-local TypeScript is inlined. Every dependency — the `@imajin/*`
 * workspace packages and third-party packages — is left external (they are
 * this package's `dependencies`, so tsup externalizes them) and loaded by
 * Node's native ESM resolver from its own `node_modules`, each at the version
 * its owner declares.
 */
export default defineConfig({
  // Output is named after the entry key, not its (out-of-package) path.
  entry: { index: '../../scripts/lib/provision-service-bootstrap.ts' },
  format: ['esm'],
  outExtension: () => ({ js: '.mjs' }),
  platform: 'node',
  target: 'node22',
  dts: false,
  clean: true,
  // One file: the kernel modules stay lazily evaluated behind the library's
  // dynamic `import()`s, so `--dry-run` can still set DATABASE_URL first.
  splitting: false,
});
