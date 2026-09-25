#!/usr/bin/env node
// pin-peer-version.mjs — derive a deterministic, concrete version to install
// for a declared peerDependency range (#2383).
//
// scripts/smoke-test-sdk-install.sh used to install every declared
// peerDependency at its raw declared range (e.g. `next@>=15.5.24`) and let
// npm resolve whatever the registry's *current* latest matching version
// happened to be at the moment CI ran. That's non-deterministic by
// construction: the exact version actually smoke-tested silently drifts
// every time upstream publishes a new release the range still matches,
// including a new major — which is literally how this smoke test ended up
// installing Next.js 16 while #2383 was being investigated, an unrelated
// moving target layered on top of the real `next/server` resolution bug
// (see shim-esm-subpaths.mjs for that fix). Pinning to the floor of the
// declared range — the exact minimum version the package's own
// peerDependencies entry names as supported — makes the smoke test
// reproducible without guessing at a version nobody declared anywhere.
//
// Only handles the single-bound range shapes actually used by this repo's
// peerDependencies today: an exact version, or one prefixed with `^`, `~`,
// or `>=` (all of which share the same floor: the literal version itself).
// Anything else (comma-separated ranges, `||`, exclusive `>`, `*`/`x`
// ranges, dist-tags) intentionally resolves to `null` so the caller falls
// back to installing the original declared range as-is, rather than this
// module silently mis-deriving a pin for a shape it hasn't been taught.
const SINGLE_BOUND_RANGE_RE = /^(?:\^|~|>=|=)?\s*(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/**
 * @param {string} range a declared peerDependency range, e.g. ">=15.5.24"
 * @returns {string | null} the concrete floor version to pin to, or null if
 *   `range` isn't one of the single-bound shapes this can safely derive a
 *   pin from.
 */
export function floorVersion(range) {
  if (typeof range !== 'string') return null;
  const match = SINGLE_BOUND_RANGE_RE.exec(range.trim());
  return match ? match[1] : null;
}

// Only run as a CLI when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const range = process.argv[2];
  if (!range) {
    console.error('usage: pin-peer-version.mjs <range>');
    process.exit(1);
  }
  // Prints the pinned version, or nothing (empty stdout) when no
  // deterministic pin can be derived — the shell caller treats an empty
  // result as "fall back to the original range".
  process.stdout.write(floorVersion(range) ?? '');
}
