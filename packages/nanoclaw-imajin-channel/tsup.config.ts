import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // ESM only. @imajin/auth is itself ESM-only (see packages/auth/tsup.config.ts),
  // so a CJS build here would `require()` fine at bundle time but throw
  // ERR_REQUIRE_ESM the moment anything actually executed the resulting
  // dist/index.cjs and hit that import. The mcp-proxy/server.ts and
  // usage-emitter/index.ts entry points stay tsx-only (see the "mcp-proxy"
  // and "usage-emitter" package.json scripts) — they're run as standalone
  // sidecars, not imported through the package's "." export, so they don't
  // need their own dist bundle.
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
});
