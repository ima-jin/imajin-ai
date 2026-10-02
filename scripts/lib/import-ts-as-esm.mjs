/**
 * scripts/lib/import-ts-as-esm.mjs (#2483)
 *
 * Load a TypeScript entry module (and the repo-local TypeScript it imports,
 * e.g. the kernel's `apps/kernel/src/**`) as a true ES module under plain
 * `node` — no `tsx`, no CommonJS.
 *
 * Why: the repo's roots (`package.json`, `apps/kernel/package.json`) have no
 * `"type": "module"`, so `tsx` compiles every `.ts` file under them to CJS and
 * turns each import into a `require()`. Node's CJS resolver then fails on
 * ESM-only packages (`@ipld/dag-cbor`: `No "exports" main defined`), and
 * patching export maps is whack-a-mole. Here everything this repo owns — the
 * TypeScript sources AND the `@imajin/*` workspace packages' built `dist`,
 * which Node's native ESM resolver would trip over (e.g. an extensionless
 * `next/server` import) — is bundled into ONE ESM module with esbuild, while
 * every third-party dependency (anything resolved under `node_modules`) stays
 * external and is loaded by Node's native ESM resolver.
 *
 * Constraint: callers import the result with `import()` only after
 * `pnpm -r --filter './packages/**' build`, exactly like the deploy does.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// ESM output has no `require`; esbuild's shim for any `require()` in bundled
// source uses this one when it exists.
const REQUIRE_BANNER =
  "import { createRequire as __bundleCreateRequire } from 'node:module';\n" +
  'const require = __bundleCreateRequire(import.meta.url);';

/**
 * esbuild plugin: every bare specifier (a package, builtin or `node:` module)
 * is resolved by esbuild from the importing file's directory — so pnpm's
 * per-package `node_modules` still works. A third-party package (its real path
 * is under `node_modules`) is left external under its absolute path, so the
 * bundle can live anywhere (a temp dir) and Node still loads each dependency
 * with the right module format. A workspace package resolves outside
 * `node_modules` (pnpm links it) and is bundled. `@/…` is the kernel's
 * tsconfig path alias for repo-local source: resolved by esbuild itself.
 */
const externalizeDependencies = {
  name: 'externalize-dependencies',
  setup(buildApi) {
    buildApi.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData === 'inner' || args.path.startsWith('@/')) return undefined;
      if (args.path.startsWith('node:')) return { path: args.path, external: true };

      const resolved = await buildApi.resolve(args.path, {
        kind: args.kind,
        resolveDir: args.resolveDir,
        importer: args.importer,
        pluginData: 'inner',
      });
      if (resolved.errors.length > 0) return { errors: resolved.errors };
      if (resolved.external) return { path: args.path, external: true };
      if (!resolved.path.split(path.sep).includes('node_modules')) return { path: resolved.path };
      // `require()` needs a path; `import` takes a file URL.
      const target = args.kind === 'require-call' ? resolved.path : pathToFileURL(resolved.path).href;
      return { path: target, external: true };
    });
  },
};

/**
 * Bundle `entryFile` to ESM and import it. Module-resolution failures of any
 * dependency (at bundle time, or when Node loads an external) reject.
 *
 * @param {string} entryFile absolute path of the `.ts` entry module
 * @returns {Promise<Record<string, unknown>>} the module namespace
 */
export async function importTsAsEsm(entryFile) {
  const { outputFiles } = await build({
    entryPoints: [entryFile],
    bundle: true,
    write: false,
    outfile: 'bundle.mjs',
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent',
    banner: { js: REQUIRE_BANNER },
    plugins: [externalizeDependencies],
  });

  const dir = await mkdtemp(path.join(tmpdir(), 'ts-as-esm-'));
  try {
    const file = path.join(dir, 'bundle.mjs');
    await writeFile(file, outputFiles[0].contents);
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
