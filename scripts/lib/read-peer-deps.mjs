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
// Usage: node read-peer-deps.mjs <path-to-package.json>
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';

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
 * Reads and parses a `package.json` from a CLI-supplied path, narrowly
 * validated first: this script only ever needs to read a file literally
 * named `package.json` that already exists on disk, so requiring both
 * (before *and* after resolving symlinks) is enough to keep an arbitrary
 * caller-supplied path from being used to read anything else on the
 * filesystem, without breaking the script's `<path-to-package.json>` CLI
 * contract (#2380).
 *
 * @param {string} pkgJsonPathArg
 */
export function readPackageJsonSafely(pkgJsonPathArg) {
  if (typeof pkgJsonPathArg !== 'string' || pkgJsonPathArg.length === 0) {
    throw new Error('a package.json path is required');
  }
  if (basename(pkgJsonPathArg) !== 'package.json') {
    throw new Error(`expected a path ending in "package.json", got: ${pkgJsonPathArg}`);
  }
  if (!existsSync(pkgJsonPathArg)) {
    throw new Error(`no such file: ${pkgJsonPathArg}`);
  }
  const resolvedPath = realpathSync(pkgJsonPathArg);
  if (basename(resolvedPath) !== 'package.json') {
    throw new Error(`resolved path does not end in "package.json": ${resolvedPath}`);
  }
  return JSON.parse(readFileSync(resolvedPath, 'utf8'));
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
