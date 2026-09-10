import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // ESM only — see packages/cid/tsup.config.ts for the general rationale.
  // nanoid v5 (a runtime dependency here) is "type": "module" with no
  // "require" condition in its exports map, so a CJS build would resolve at
  // install time and then throw ERR_REQUIRE_ESM the moment anything actually
  // executed the resulting dist/index.cjs under plain Node.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // withLogger (src/middleware.ts) imports NextRequest/NextResponse from
  // next/server. next is already a peerDependency; next/server is listed
  // explicitly since it's a distinct import specifier from the bare "next"
  // package name.
  external: ['next', 'next/server'],
});
