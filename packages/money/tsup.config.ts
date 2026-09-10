import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // A real dist build (rather than pointing "main"/"types" straight at
  // src/index.ts, like packages/bus still does) is required here, not just
  // stylistic: this package uses bigint literals (`0n`, `10n`, ...), a
  // syntax TypeScript only allows when the *consumer's own* tsconfig
  // targets ES2020+. Several apps in this monorepo (e.g. apps/coffee)
  // still target ES2017. Pointing "types" at raw .ts source would pull
  // this file directly into their compilation and fail with TS2737
  // ("BigInt literals are not available..."); shipping a compiled
  // dist/index.d.ts sidesteps that entirely, since a declaration file
  // never contains executable bigint-literal syntax.
  //
  // ESM only, matching packages/fair's rationale: @imajin/auth (a runtime
  // dependency, for the Ed25519 signing helpers) is itself ESM-only (see
  // packages/auth/tsup.config.ts — its @noble/* dependencies ship no "require"
  // condition). A CJS build here would `require()` fine at bundle time but
  // throw ERR_REQUIRE_ESM the moment anything actually executed the
  // resulting dist/index.cjs under plain Node.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
