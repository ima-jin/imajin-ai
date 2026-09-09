/**
 * Tests for scripts/prepare-npm-publish.mjs (#2065).
 *
 * Covers:
 *  - path validation: the source package dir must live under packages/, and
 *    the output dir must live under the repo root or the OS temp dir. Both
 *    CLI args are canonicalized with `resolve()` before use, so a caller
 *    cannot walk them outside those roots with `..` segments or an absolute
 *    path escape.
 *  - secret isolation: this script runs inside scripts/publish-package.sh
 *    while NODE_AUTH_TOKEN/GITHUB_TOKEN are present in the environment for
 *    the subsequent `npm publish` step. It never reads `process.env` at all,
 *    so none of those values can ever reach a log line — these tests assert
 *    that directly, by setting each secret env var to a value distinct from
 *    anything in the package fixture and confirming it never appears in
 *    stdout/stderr, while the package's own (non-secret) name/version still
 *    do.
 *
 * The script is exercised as a subprocess (not imported directly) because it
 * is a CLI entrypoint that runs its top-level logic — including
 * `process.exit()` on bad args — as an import side effect.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../prepare-npm-publish.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGES_ROOT = join(REPO_ROOT, 'packages');

function writePackageFixture(dir, pkg) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
}

function runScript(args, env = process.env) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      encoding: 'utf8',
      env,
    });
    return { status: 0, output: stdout };
  } catch (e) {
    return {
      status: e.status ?? 1,
      output: (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? ''),
    };
  }
}

describe('prepare-npm-publish.mjs — path validation', () => {
  it('publishes a package that lives under packages/', () => {
    const srcDir = mkdtempSync(join(PACKAGES_ROOT, '.tmp-prepare-npm-publish-src-'));
    const outDir = mkdtempSync(join(tmpdir(), 'prepare-npm-publish-out-'));
    try {
      writePackageFixture(srcDir, {
        name: '@imajin/fixture',
        version: '1.2.3',
        private: true,
      });

      const { status, output } = runScript([srcDir, outDir]);

      expect(status).toBe(0);
      expect(output).toContain('Ready to publish: @ima-jin/fixture@1.2.3');
    } finally {
      rmSync(srcDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('refuses a source dir outside packages/', () => {
    // The repo root itself has a package.json but is not a workspace package.
    const outDir = mkdtempSync(join(tmpdir(), 'prepare-npm-publish-out-'));
    try {
      const { status, output } = runScript([REPO_ROOT, outDir]);

      expect(status).toBe(1);
      expect(output).toContain('Refusing to read package dir outside');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('refuses a source dir that escapes packages/ via ..', () => {
    const escaped = resolve(PACKAGES_ROOT, '..', '..');
    const outDir = mkdtempSync(join(tmpdir(), 'prepare-npm-publish-out-'));
    try {
      const { status, output } = runScript([escaped, outDir]);

      expect(status).toBe(1);
      expect(output).toContain('Refusing to read package dir outside');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('refuses an output dir outside the repo root and OS temp dir', () => {
    const srcDir = mkdtempSync(join(PACKAGES_ROOT, '.tmp-prepare-npm-publish-src-'));
    try {
      writePackageFixture(srcDir, { name: '@imajin/fixture', version: '1.0.0' });

      const { status, output } = runScript([srcDir, '/this-path-should-not-exist-2065']);

      expect(status).toBe(1);
      expect(output).toContain('Refusing to write output outside allowed roots');
    } finally {
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  it('refuses a sibling directory whose name merely starts with "packages" (S8707)', () => {
    // Guards against the classic `target.startsWith(root)` boundary bug: a
    // naive string-prefix check would let "packages-evil" pass because it
    // textually starts with "packages", even though it is not a descendant
    // of PACKAGES_ROOT. isPathWithin() uses path.relative() instead, which
    // correctly rejects this.
    const evilRoot = `${PACKAGES_ROOT}-evil`;
    const outDir = mkdtempSync(join(tmpdir(), 'prepare-npm-publish-out-'));
    try {
      writePackageFixture(evilRoot, { name: '@imajin/fixture', version: '1.0.0' });

      const { status, output } = runScript([evilRoot, outDir]);

      expect(status).toBe(1);
      expect(output).toContain('Refusing to read package dir outside');
    } finally {
      rmSync(evilRoot, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

describe('prepare-npm-publish.mjs — secret isolation', () => {
  it.each([
    ['NODE_AUTH_TOKEN', 'npm_totallyFakeTestToken1234567890'],
    ['NPM_TOKEN', 'npm_anotherFakeTestToken0987654321'],
    ['GITHUB_TOKEN', 'ghp_yetAnotherFakeTestToken1122334455'],
  ])('never prints the %s value from the environment', (envVar, fakeSecret) => {
    const srcDir = mkdtempSync(join(PACKAGES_ROOT, '.tmp-prepare-npm-publish-src-'));
    const outDir = mkdtempSync(join(tmpdir(), 'prepare-npm-publish-out-'));
    try {
      // The fixture's own (non-secret) name/version are distinct from the
      // fake secret, so a passing `toContain` below proves normal package
      // data is still logged — the secret is absent specifically because
      // the script never reads it, not because logging was suppressed.
      writePackageFixture(srcDir, { name: '@imajin/fixture', version: '1.0.0' });

      const { status, output } = runScript([srcDir, outDir], {
        ...process.env,
        [envVar]: fakeSecret,
      });

      expect(status).toBe(0);
      expect(output).toContain('@ima-jin/fixture@1.0.0');
      expect(output).not.toContain(fakeSecret);
    } finally {
      rmSync(srcDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('does not read process.env anywhere in the module source', async () => {
    // Belt-and-suspenders static check: even a future edit that logs some new
    // dynamic value cannot reintroduce a secret leak via process.env, because
    // there is no reference to it left to reintroduce a taint flow from.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(SCRIPT, 'utf8');

    expect(source).not.toMatch(/process\.env/);
  });
});
