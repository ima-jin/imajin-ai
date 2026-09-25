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
import { readFileSync } from 'node:fs';

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

// Only run as a CLI when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const pkgJsonPath = process.argv[2];
  if (!pkgJsonPath) {
    console.error('usage: read-peer-deps.mjs <path-to-package.json>');
    process.exit(1);
  }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  for (const [name, range] of collectRequiredPeerDeps(pkg)) {
    process.stdout.write(`${name}\t${range}\n`);
  }
}
