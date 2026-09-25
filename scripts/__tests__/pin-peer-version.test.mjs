// pin-peer-version.test.mjs — unit tests for scripts/lib/pin-peer-version.mjs
// (#2383).
//
// This is the version-determinism half of the #2383 fix:
// scripts/smoke-test-sdk-install.sh's peer-collection loop uses this to pin
// each declared peerDependency range (e.g. `next`'s `>=15.5.24`) to a
// concrete version instead of installing the range as-is and letting npm
// resolve whatever the registry's current latest matching release happens
// to be. See scripts/lib/shim-esm-subpaths.mjs (and its own tests) for the
// other half — the actual `next/server` ESM resolution fix, which pinning
// alone does not solve.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { floorVersion } from '../lib/pin-peer-version.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('../lib/pin-peer-version.mjs', import.meta.url));

describe('floorVersion (#2383)', () => {
  it('extracts the floor version from a ">=" range (the actual @ima-jin/* next peer shape)', () => {
    expect(floorVersion('>=15.5.24')).toBe('15.5.24');
  });

  it('extracts the floor version from a "^" range', () => {
    expect(floorVersion('^0.45.1')).toBe('0.45.1');
  });

  it('extracts the floor version from a "~" range', () => {
    expect(floorVersion('~18.2.0')).toBe('18.2.0');
  });

  it('returns the version itself for an exact version with no operator', () => {
    expect(floorVersion('15.5.24')).toBe('15.5.24');
  });

  it('returns the version itself for an explicit "=" range', () => {
    expect(floorVersion('=15.5.24')).toBe('15.5.24');
  });

  it('tolerates surrounding whitespace', () => {
    expect(floorVersion('  >=15.5.24  ')).toBe('15.5.24');
  });

  it('handles a prerelease version', () => {
    expect(floorVersion('>=15.0.0-rc.1')).toBe('15.0.0-rc.1');
  });

  it('returns null for a comma-separated range it cannot safely pin', () => {
    expect(floorVersion('>=15.5.24 <16.0.0')).toBeNull();
  });

  it('returns null for an "||" range', () => {
    expect(floorVersion('^15.0.0 || ^16.0.0')).toBeNull();
  });

  it('returns null for an exclusive ">" range', () => {
    expect(floorVersion('>15.5.24')).toBeNull();
  });

  it('returns null for a wildcard range', () => {
    expect(floorVersion('*')).toBeNull();
  });

  it('returns null for a dist-tag like "latest"', () => {
    expect(floorVersion('latest')).toBeNull();
  });

  it('returns null for a workspace protocol range', () => {
    expect(floorVersion('workspace:*')).toBeNull();
  });

  it('returns null for a non-string input', () => {
    expect(floorVersion(undefined)).toBeNull();
    expect(floorVersion(null)).toBeNull();
  });
});

describe('pin-peer-version.mjs CLI', () => {
  it('prints the pinned version for a pinnable range', () => {
    const output = execFileSync('node', [SCRIPT_PATH, '>=15.5.24'], { encoding: 'utf8' });
    expect(output).toBe('15.5.24');
  });

  it('prints nothing for a range that cannot be pinned', () => {
    const output = execFileSync('node', [SCRIPT_PATH, '>=15.5.24 <16.0.0'], { encoding: 'utf8' });
    expect(output).toBe('');
  });

  it('exits non-zero when no range argument is given', () => {
    expect(() => execFileSync('node', [SCRIPT_PATH], { stdio: 'pipe' })).toThrow();
  });
});
