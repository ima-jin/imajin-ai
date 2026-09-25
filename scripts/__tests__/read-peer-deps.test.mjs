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
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRequiredPeerDeps } from '../lib/read-peer-deps.mjs';

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

describe('read-peer-deps.mjs CLI', () => {
  it('prints "<name>\\t<range>" lines for required peers and omits optional ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'read-peer-deps-'));
    try {
      const pkgJsonPath = join(dir, 'package.json');
      writeFileSync(
        pkgJsonPath,
        JSON.stringify({
          name: '@ima-jin/auth',
          peerDependencies: { next: '>=15.5.24', 'drizzle-orm': '^0.45.1' },
          peerDependenciesMeta: { 'drizzle-orm': { optional: true } },
        }),
      );

      const output = execFileSync('node', [SCRIPT_PATH, pkgJsonPath], { encoding: 'utf8' });

      expect(output).toBe('next\t>=15.5.24\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints nothing for a package.json with no peerDependencies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'read-peer-deps-'));
    try {
      const pkgJsonPath = join(dir, 'package.json');
      writeFileSync(pkgJsonPath, JSON.stringify({ name: '@ima-jin/config' }));

      const output = execFileSync('node', [SCRIPT_PATH, pkgJsonPath], { encoding: 'utf8' });

      expect(output).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
