#!/usr/bin/env node
/**
 * Unbound-`React`-in-dist guard (#2401).
 *
 * ## Why this exists
 *
 * Every chat thread in prod (v0.8.6) hit the Next.js error boundary with
 * `ReferenceError: React is not defined`, thrown by `VoiceRecorder` from
 * `@imajin/input`. Root cause: `packages/input/tsconfig.json` overrode
 * `compilerOptions.jsx` to `"preserve"` (a leftover from the package's
 * pre-#1547 standalone tsconfig). tsup's own `jsx: 'automatic'` build option
 * (`tsup.config.ts`) is not what decides esbuild's JSX transform mode when a
 * `tsconfig.json` is present — esbuild reads the tsconfig `jsx` field for
 * that, so the `"preserve"` override silently defeated the automatic
 * runtime, and every component in the package fell back to the classic
 * `React.createElement(...)` transform.
 *
 * That transform emits the literal, unrenamed identifier `React` for the
 * component whose own source file has no explicit `import React from
 * 'react'` — the automatic runtime doesn't need one, since it imports `jsx`/
 * `jsxs` from `react/jsx-runtime` instead. Every *other* component in the
 * same package happened to survive because each of those files has its own
 * explicit `import React from 'react'`, which esbuild's bundler renames
 * (`React2`, `React3`, ...) but keeps bound and working. `VoiceRecorder.tsx`
 * had no such import, so its `React.createElement` calls had nothing to
 * resolve `React` to at runtime.
 *
 * `packages/media` had the exact same tsconfig override and the exact same
 * latent defect — it just hadn't thrown yet, because every current source
 * file in that package happens to have its own explicit `React` import.
 *
 * ## What it checks
 *
 * For every built `dist/*.js` / `dist/*.cjs` file under each package's
 * `dist` directory (skipping sourcemaps and declaration files), this guard looks for a
 * property access on the *exact, unrenamed* identifier `React` (e.g.
 * `React.createElement`, `React.Fragment`) and fails if that same file has
 * no binding that would put `React` in scope — no `import React from
 * 'react'`, no `import { default as React } from 'react'`, no bare
 * `require('react')`/`__toESM` assigned to a variable literally named
 * `React`. A renamed binding (`React2`, `import_react`, ...) does not count,
 * because a renamed binding is never what the classic JSX pragma emits —
 * only the literal `React` identifier is.
 *
 * This is a narrow, false-positive-resistant signal for exactly this defect
 * class: it does not try to determine whether the automatic or classic JSX
 * transform ran, only whether the dist output would throw
 * `ReferenceError: React is not defined` the moment it renders.
 *
 * ## Usage
 *
 * Run *after* `pnpm build` (it inspects built dist output, not source):
 *   `node scripts/ci-guard-dist-react-binding.mjs`
 *
 * Env overrides (for tests):
 *   - `CI_GUARD_WORKDIR` — repo root (default: two levels up from this file)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.CI_GUARD_WORKDIR
  ? resolve(process.env.CI_GUARD_WORKDIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES_DIR = join(ROOT, 'packages');

const DIST_EXTENSIONS = new Set(['.js', '.cjs']);

// A property access on the *literal, unrenamed* `React` identifier — the
// only shape the classic JSX pragma ever emits. `(?<![.\w$])` stops this
// from matching the tail of `React2.`/`import_react.` etc.
const BARE_REACT_USAGE_RE = /(?<![.\w$])React\.\w+/g;

// Anything that would put a binding literally named `React` (not `React2`,
// not `import_react`) into this file's module scope.
const REACT_BINDING_RE =
  /(?:^|[\n;])\s*import\s+React\s*[,\s]|(?:^|[\n;])\s*import\s*\{[^}]*\bdefault\s+as\s+React\b[^}]*\}\s*from|(?:^|[\n;])\s*(?:var|let|const)\s+React\s*=/;

/** Recursively lists every `dist/*.js` / `dist/*.cjs` file under each `packages/*` package. */
function listDistFiles() {
  const out = [];
  if (!existsSync(PACKAGES_DIR)) return out;
  for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const distDir = join(PACKAGES_DIR, pkg.name, 'dist');
    if (!existsSync(distDir)) continue;
    out.push(...listFilesRecursive(distDir));
  }
  return out;
}

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
      continue;
    }
    const ext = entry.name.slice(entry.name.lastIndexOf('.'));
    if (!DIST_EXTENSIONS.has(ext)) continue;
    out.push(full);
  }
  return out;
}

/** Scans one dist file. Returns `{ file, count }` if it uses an unbound bare `React.`, else `null`. */
function scanFile(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const usages = content.match(BARE_REACT_USAGE_RE);
  if (!usages || usages.length === 0) return null;
  if (REACT_BINDING_RE.test(content)) return null;
  return { file: relative(ROOT, filePath).replaceAll('\\', '/'), count: usages.length };
}

function scanRepo() {
  return listDistFiles()
    .map(scanFile)
    .filter((v) => v !== null)
    .sort((a, b) => a.file.localeCompare(b.file));
}

function main() {
  const violations = scanRepo();

  if (violations.length > 0) {
    console.error(`\nFAIL: ${violations.length} dist file(s) reference an unbound \`React\` identifier:\n`);
    for (const v of violations) {
      console.error(`  - ${v.file}: ${v.count} unbound \`React.*\` reference(s)`);
    }
    console.error(
      '\nThis is the #2401 defect class: a component compiled with the classic JSX ' +
        "transform (`React.createElement(...)`) but no `import React from 'react'` in its " +
        'own source file, and no automatic-runtime import (`react/jsx-runtime`) either. ' +
        "Check the package's tsconfig.json for a `\"jsx\": \"preserve\"` (or other non-" +
        '`react-jsx`) override — tsup/esbuild reads that field to decide the JSX transform ' +
        "mode, and it silently overrides tsup.config.ts's own `jsx: 'automatic'` setting.",
    );
    process.exit(1);
    return;
  }

  console.log('PASS: no dist file references an unbound `React` identifier.');
  process.exit(0);
}

main();
