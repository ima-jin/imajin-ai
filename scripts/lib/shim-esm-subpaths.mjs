#!/usr/bin/env node
// shim-esm-subpaths.mjs — make ESM `import`s of a no-`exports`-map peer's
// subpaths (e.g. `next/server`, `next/headers`) resolvable under plain Node
// (#2383).
//
// ## Root cause
//
// `@ima-jin/auth` (and `@ima-jin/config`, `@ima-jin/logger`) are published as
// `"type": "module"` and statically `import { NextResponse } from
// "next/server"` (auth's top-level barrel eagerly re-exports
// `require-auth.ts`, which does this at module scope — so this fires just
// from loading the package, regardless of what a caller actually uses).
// `next` itself ships **no `"exports"` field at all**, in every published
// version (verified against both 15.5.24 and 16.3.6, #2383) — Next.js is
// designed to be resolved by its own bundler (webpack/Turbopack) or by CJS
// `require()`, not by Node's raw ESM loader. Without an `"exports"` map,
// Node's ESM resolver requires an exact, literal file match for a subpath
// specifier and — unlike CJS `require`, which probes `.js`/`.json`/index
// files — never appends an extension. So `import ... from "next/server"`
// fails to find `next/server.js` on its own:
//
//   Cannot find module '.../node_modules/next/server' imported from ...
//   Did you mean to import "next/server.js"?
//
// This is not a version issue (pinning `next` to a different version, see
// pin-peer-version.mjs, does not change any of the above) and it is not
// fixable by adding a synthetic `"exports"` map to the installed `next`
// package.json either — once an `"exports"` field exists at all, Node
// enforces it against *every* subpath, including `next/server.js`'s own
// internal self-referencing requires of deep, version-specific paths like
// `next/dist/server/web/spec-extension/request` that a hand-written map
// could never enumerate correctly (confirmed locally: doing this trades the
// original failure for "Package subpath './dist/server/...' is not defined
// by exports").
//
// ## Fix
//
// For each `<subpath>` actually referenced via `<peerName>/<subpath>` in an
// installed `@ima-jin/*` package's compiled output, write a **plain,
// extension-less** file next to the peer's own `<subpath>.js` (e.g.
// `node_modules/next/server`) containing a single-level CommonJS
// re-export: `module.exports = require('./<subpath>.js');`. No `"exports"`
// field is touched, so the peer's own internal resolution is completely
// unaffected. An extension-less file's module format falls back to the
// nearest package.json's `"type"` field, which `next` does not set (so it's
// CommonJS, same as `next/server.js` itself), and Node's `cjs-module-lexer`
// statically recognizes this exact `module.exports = require(...)` shape to
// recover named exports — so `import { NextResponse } from "next/server"`
// from an ES module resolves through the normal CJS/ESM interop path, same
// as it would through a real bundler. Verified locally end-to-end against
// both next@15.5.24 and next@16.3.6 with a real built `@ima-jin/auth`
// tarball (#2383).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

const IMA_JIN_SCOPE = '@ima-jin';

// True when `target` (already resolved/canonicalized) is `root` itself or a
// descendant of it — the same resolve-then-check-the-prefix containment
// pattern used by scripts/lib/read-peer-deps.mjs and
// scripts/prepare-npm-publish.mjs (jssecurity:S8707), applied here so a
// `peerName` can never make the shim files below land outside the scratch
// directory's own `node_modules`.
function isPathWithin(root, target) {
  return target === root || target.startsWith(root + sep);
}

// Matches a bare-specifier reference to `<peerName>/<subpath>` shaped like
// what tsup emits: `from "next/server"`, `import("next/headers")`, or
// `require("next/server")`. `<subpath>` is restricted to a single path
// segment of identifier-safe characters — deep/internal peer paths (e.g.
// `next/dist/...`) are never matched, so this can never try to shim
// something that isn't a public, single-segment subpath import.
function subpathUsageRegExp(peerName) {
  const escapedPeerName = peerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:from|import\\(|require\\()\\s*['"]${escapedPeerName}/([A-Za-z0-9_-]+)['"]`, 'g');
}

/**
 * @param {string} sourceCode
 * @param {string} peerName e.g. "next"
 * @returns {Set<string>} subpaths referenced, e.g. {"server", "headers"}
 */
export function findPeerSubpathsUsed(sourceCode, peerName) {
  const subpaths = new Set();
  const re = subpathUsageRegExp(peerName);
  let match;
  while ((match = re.exec(sourceCode))) {
    subpaths.add(match[1]);
  }
  return subpaths;
}

/**
 * Recursively collects every `.js`/`.mjs`/`.cjs` file under `dir`.
 * @param {string} dir
 * @returns {string[]} absolute file paths
 */
function collectJsFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectJsFiles(entryPath));
    } else if (entry.isFile() && /\.(m|c)?js$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

/**
 * Writes an extension-less CommonJS re-export shim for `<peerDir>/<subpath>`
 * pointing at the sibling `<subpath>.js`, unless the shim already exists or
 * the source file it would re-export doesn't exist.
 *
 * @param {string} peerDir absolute path to the installed peer package, e.g.
 *   `node_modules/next`
 * @param {string} subpath e.g. "server"
 * @returns {boolean} true if a shim file was written
 */
export function ensureEsmSubpathShim(peerDir, subpath) {
  const sourceFile = join(peerDir, `${subpath}.js`);
  const targetFile = join(peerDir, subpath);
  if (!existsSync(sourceFile) || existsSync(targetFile)) return false;
  writeFileSync(targetFile, `module.exports = require('./${subpath}.js');\n`);
  return true;
}

/**
 * Scans every installed `@ima-jin/*` package's compiled output for
 * `<peerName>/<subpath>` references and, for each `peerName` that has no
 * `"exports"` field in its own installed package.json, shims every
 * referenced subpath that needs it (#2383).
 *
 * @param {string} scratchDir the scratch install directory (the smoke
 *   script's cwd — contains `node_modules` directly)
 * @param {string[]} peerNames peer package names actually installed, e.g.
 *   `["next"]`
 * @returns {{ peerName: string, subpath: string }[]} every shim written
 */
export function shimEsmSubpaths(scratchDir, peerNames) {
  const nodeModules = resolve(scratchDir, 'node_modules');
  const scopeDir = join(nodeModules, IMA_JIN_SCOPE);
  const written = [];

  for (const peerName of peerNames) {
    const peerDir = resolve(nodeModules, peerName);
    // A peer name that resolves outside `node_modules` (e.g. via "../"
    // segments) is never a real installable package name — skip it rather
    // than letting it influence any path below.
    if (!isPathWithin(nodeModules, peerDir)) continue;
    const peerPkgJsonPath = join(peerDir, 'package.json');
    if (!existsSync(peerPkgJsonPath)) continue;

    const peerPkgJson = JSON.parse(readFileSync(peerPkgJsonPath, 'utf8'));
    // A peer that already declares its own `"exports"` map is assumed to
    // have deliberately defined its own public subpaths; shimming around it
    // would fight, not fix, that map.
    if (peerPkgJson.exports) continue;

    const subpathsUsed = new Set();
    for (const jsFile of collectJsFiles(scopeDir)) {
      const source = readFileSync(jsFile, 'utf8');
      for (const subpath of findPeerSubpathsUsed(source, peerName)) {
        subpathsUsed.add(subpath);
      }
    }

    for (const subpath of subpathsUsed) {
      if (ensureEsmSubpathShim(peerDir, subpath)) {
        written.push({ peerName, subpath });
      }
    }
  }

  return written;
}

// Only run as a CLI when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const [scratchDir, ...peerNames] = process.argv.slice(2);
  if (!scratchDir || peerNames.length === 0) {
    console.error('usage: shim-esm-subpaths.mjs <scratch-dir> <peer-name> [<peer-name> ...]');
    process.exit(1);
  }
  const written = shimEsmSubpaths(scratchDir, peerNames);
  if (written.length === 0) {
    console.log('No ESM subpath shims needed.');
  } else {
    for (const { peerName, subpath } of written) {
      console.log(`Shimmed ${peerName}/${subpath} for plain-Node ESM resolution (#2383).`);
    }
  }
}
