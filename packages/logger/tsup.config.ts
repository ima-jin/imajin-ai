import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries — one per exports-map key, following #2141's pattern for
  // auth's multi-entry build. db.ts is the `./db` subpath: the only file in
  // this package that imports `@imajin/db`, kept as a separate entry so the
  // core `.` entry's dist output (and its declared dependencies) never
  // reference Postgres/drizzle (#2143).
  entry: ['src/index.ts', 'src/db.ts'],
  // ESM only — see packages/cid/tsup.config.ts for the general rationale.
  // nanoid v5 (a runtime dependency here) is "type": "module" with no
  // "require" condition in its exports map, so a CJS build would resolve at
  // install time and then throw ERR_REQUIRE_ESM the moment anything actually
  // executed the resulting dist/index.cjs under plain Node.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    // withLogger (src/middleware.ts) imports NextRequest/NextResponse from
    // next/server. next is already a peerDependency; next/server is listed
    // explicitly since it's a distinct import specifier from the bare "next"
    // package name.
    'next',
    'next/server',
    // db.ts's only external dependency — an optional peerDependency (#2143),
    // never bundled so the `./db` entry keeps resolving the consumer's own
    // @imajin/db instance rather than a private copy.
    '@imajin/db',
  ],
});
