// read-peer-deps.test.mjs — unit tests for scripts/lib/read-peer-deps.mjs
// (#2380).
//
// This is the peer-selection logic scripts/smoke-test-sdk-install.sh's
// peer-collection loop delegates to for every `@ima-jin/*` package.json it
// finds under node_modules. It has no network dependency, unlike the smoke
// script itself (which needs a real GitHub Packages token and registry
// access) — see scripts/smoke-test-sdk-install-no-prune.test.sh for the
// companion, also network-free regression test covering the actual npm
// pruning bug this issue fixed.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRequiredPeerDeps, readPackageJsonSafely } from '../lib/read-peer-deps.mjs';

const SCRIPT_PATH = fileURLToPath(new URL('../lib/read-peer-deps.mjs', import.meta.url));

describe('collectRequiredPeerDeps (#2380)', () => {
  it('returns every declared peerDependency when peerDependenciesMeta is absent', () => {
    const pkg = { peerDependencies: { next: '>=15.5.24', react: '^18.0.0' } };
    expect(collectRequiredPeerDeps(pkg)).toEqual([
      ['next', '>=15.5.24'],
      ['react', '^18.0.0'],
    ]);
  });

  it('skips a peer marked optional in peerDependenciesMeta (e.g. @ima-jin/auth + drizzle-orm)', () => {
    const pkg = {
      peerDependencies: { next: '>=15.5.24', 'drizzle-orm': '^0.45.1' },
      peerDependenciesMeta: { 'drizzle-orm': { optional: true } },
    };
    expect(collectRequiredPeerDeps(pkg)).toEqual([['next', '>=15.5.24']]);
  });

  it('returns an empty list when there are no peerDependencies', () => {
    expect(collectRequiredPeerDeps({})).toEqual([]);
  });

  it('treats a peerDependenciesMeta entry without optional:true as required', () => {
    const pkg = {
      peerDependencies: { next: '>=15.5.24' },
      peerDependenciesMeta: { next: {} },
    };
    expect(collectRequiredPeerDeps(pkg)).toEqual([['next', '>=15.5.24']]);
  });

  it('ignores peerDependenciesMeta entries for peers that are not actually declared', () => {
    const pkg = {
      peerDependencies: { next: '>=15.5.24' },
      peerDependenciesMeta: { 'drizzle-orm': { optional: true } },
    };
    expect(collectRequiredPeerDeps(pkg)).toEqual([['next', '>=15.5.24']]);
  });
});

describe('readPackageJsonSafely (#2380, jssecurity:S8707)', () => {
  it('reads a package.json located directly under the given root', () => {
    const root = mkdtempSync(join(tmpdir(), 'read-peer-deps-root-'));
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'inside-root' }));
      expect(readPackageJsonSafely('package.json', root)).toEqual({ name: 'inside-root' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads a package.json in a subdirectory of the given root', () => {
    const root = mkdtempSync(join(tmpdir(), 'read-peer-deps-root-'));
    try {
      const nested = join(root, 'node_modules', '@ima-jin', 'auth');
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: '@ima-jin/auth' }));
      expect(readPackageJsonSafely('node_modules/@ima-jin/auth/package.json', root)).toEqual({
        name: '@ima-jin/auth',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a path that does not end in "package.json"', () => {
    const root = mkdtempSync(join(tmpdir(), 'read-peer-deps-root-'));
    try {
      writeFileSync(join(root, 'not-a-manifest.json'), '{}');
      expect(() => readPackageJsonSafely('not-a-manifest.json', root)).toThrow(/package\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a "../"-style path that would escape the given root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'read-peer-deps-parent-'));
    try {
      const root = join(parent, 'root');
      mkdirSync(root);
      writeFileSync(join(parent, 'package.json'), JSON.stringify({ name: 'outside-root' }));
      expect(() => readPackageJsonSafely('../package.json', root)).toThrow(/outside/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('rejects a path that does not exist under the given root', () => {
    const root = mkdtempSync(join(tmpdir(), 'read-peer-deps-root-'));
    try {
      expect(() => readPackageJsonSafely('package.json', root)).toThrow(/no such file/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a missing path argument', () => {
    expect(() => readPackageJsonSafely('')).toThrow(/required/);
  });
});

describe('read-peer-deps.mjs CLI', () => {
  it('prints "<name>\\t<range>" lines for required peers and omits optional ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'read-peer-deps-'));
    try {
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({
          name: '@ima-jin/auth',
          peerDependencies: { next: '>=15.5.24', 'drizzle-orm': '^0.45.1' },
          peerDependenciesMeta: { 'drizzle-orm': { optional: true } },
        }),
      );

      // Invoked with cwd set to the manifest's directory and a relative
      // path argument, matching how scripts/smoke-test-sdk-install.sh
      // actually calls this script (relative to the scratch dir it never
      // cds away from).
      const output = execFileSync('node', [SCRIPT_PATH, 'package.json'], { encoding: 'utf8', cwd: dir });

      expect(output).toBe('next\t>=15.5.24\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints nothing for a package.json with no peerDependencies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'read-peer-deps-'));
    try {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@ima-jin/config' }));

      const output = execFileSync('node', [SCRIPT_PATH, 'package.json'], { encoding: 'utf8', cwd: dir });

      expect(output).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to read a package.json outside of its own cwd', () => {
    const outside = mkdtempSync(join(tmpdir(), 'read-peer-deps-outside-'));
    const cwd = mkdtempSync(join(tmpdir(), 'read-peer-deps-cwd-'));
    try {
      writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'outside-cwd' }));

      expect(() =>
        execFileSync('node', [SCRIPT_PATH, join(outside, 'package.json')], {
          encoding: 'utf8',
          cwd,
          stdio: 'pipe',
        }),
      ).toThrow();
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
