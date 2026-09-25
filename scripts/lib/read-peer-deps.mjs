#!/usr/bin/env node
// read-peer-deps.mjs — prints "<name>\t<range>" for each peerDependency
// declared in a given package.json, skipping any peer marked optional in
// peerDependenciesMeta (#2380).
//
// Extracted out of scripts/smoke-test-sdk-install.sh's peer-collection loop
// (which previously inlined this as a `node -e` heredoc) so the actual
// selection logic — which peers count, which don't — can be unit tested
// directly instead of only indirectly via a full, network-dependent
// end-to-end run of the smoke script.
//
// Usage: run with cwd set to the directory the path is relative to (or an
// absolute path under it): node read-peer-deps.mjs <path-to-package.json>
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';

/**
 * @param {{ peerDependencies?: Record<string, string>, peerDependenciesMeta?: Record<string, { optional?: boolean }> }} pkg
 * @returns {[string, string][]} [name, range] pairs for every peerDependency
 *   that isn't marked optional.
 */
export function collectRequiredPeerDeps(pkg) {
  const peers = pkg.peerDependencies || {};
  const meta = pkg.peerDependenciesMeta || {};
  return Object.entries(peers).filter(([name]) => !meta[name]?.optional);
}

/**
 * Reads and parses a `package.json` from a CLI-supplied path, confined to
 * `rootDir` (default: cwd — the smoke script's scratch directory when this
 * runs for real): the path must literally end in "package.json" and its
 * fully-resolved, symlink-free location must stay inside `rootDir`. This is
 * the standard resolve-then-check-the-prefix containment pattern (OWASP /
 * CodeQL js/path-injection) applied at both ends — before resolving
 * symlinks (rejects "../" traversal in the argument itself) and after
 * (rejects a symlink inside `rootDir` that points back out of it) — so a
 * caller-supplied path can't be used to read anything outside the expected
 * directory (#2380).
 *
 * @param {string} pkgJsonPathArg
 * @param {string} [rootDir]
 */
export function readPackageJsonSafely(pkgJsonPathArg, rootDir = process.cwd()) {
  if (typeof pkgJsonPathArg !== 'string' || pkgJsonPathArg.length === 0) {
    throw new Error('a package.json path is required');
  }
  if (basename(pkgJsonPathArg) !== 'package.json') {
    throw new Error(`expected a path ending in "package.json", got: ${pkgJsonPathArg}`);
  }
  const root = resolve(rootDir);
  const resolvedPath = resolve(root, pkgJsonPathArg);
  if (resolvedPath !== root && !resolvedPath.startsWith(root + sep)) {
    throw new Error(`refusing to read a package.json outside ${root}: ${pkgJsonPathArg}`);
  }
  if (!existsSync(resolvedPath)) {
    throw new Error(`no such file: ${pkgJsonPathArg}`);
  }
  const realPath = realpathSync(resolvedPath);
  if (realPath !== root && !realPath.startsWith(root + sep)) {
    throw new Error(`refusing to read a package.json outside ${root}: ${pkgJsonPathArg}`);
  }
  if (basename(realPath) !== 'package.json') {
    throw new Error(`resolved path does not end in "package.json": ${realPath}`);
  }
  return JSON.parse(readFileSync(realPath, 'utf8'));
}

// Only run as a CLI when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const pkgJsonPath = process.argv[2];
  if (!pkgJsonPath) {
    console.error('usage: read-peer-deps.mjs <path-to-package.json>');
    process.exit(1);
  }
  const pkg = readPackageJsonSafely(pkgJsonPath);
  for (const [name, range] of collectRequiredPeerDeps(pkg)) {
    process.stdout.write(`${name}\t${range}\n`);
  }
}
