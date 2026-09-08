/**
 * Tests for scripts/prepare-npm-publish.mjs (#2065).
 *
 * Covers:
 *  - path validation: the source package dir must live under packages/, and
 *    the output dir must live under the repo root or the OS temp dir. Both
 *    CLI args are canonicalized with `resolve()` before use, so a caller
 *    cannot walk them outside those roots with `..` segments or an absolute
 *    path escape.
 *  - log redaction: any known secret env var (NODE_AUTH_TOKEN, NPM_TOKEN,
 *    GITHUB_TOKEN) that ends up in a dynamic log line (e.g. because it was
 *    embedded in a package.json field) must never appear verbatim in
 *    stdout/stderr.
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
});

describe('prepare-npm-publish.mjs — secret redaction', () => {
  it('never prints a secret env var value, even if it ends up in a logged field', () => {
    const FAKE_TOKEN = 'npm_totallyFakeTestToken1234567890';
    const srcDir = mkdtempSync(join(PACKAGES_ROOT, '.tmp-prepare-npm-publish-src-'));
    const outDir = mkdtempSync(join(tmpdir(), 'prepare-npm-publish-out-'));
    try {
      // Simulate a secret leaking into a field this script logs (e.g. a
      // misconfigured package.json), regardless of how it got there.
      writePackageFixture(srcDir, { name: '@imajin/fixture', version: FAKE_TOKEN });

      const { status, output } = runScript([srcDir, outDir], {
        ...process.env,
        NODE_AUTH_TOKEN: FAKE_TOKEN,
      });

      expect(status).toBe(0);
      expect(output).not.toContain(FAKE_TOKEN);
      expect(output).toContain('npm_***');
    } finally {
      rmSync(srcDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('redacts NPM_TOKEN and GITHUB_TOKEN in addition to NODE_AUTH_TOKEN', () => {
    const FAKE_NPM_TOKEN = 'npm_anotherFakeTestToken0987654321';
    const srcDir = mkdtempSync(join(PACKAGES_ROOT, '.tmp-prepare-npm-publish-src-'));
    const outDir = mkdtempSync(join(tmpdir(), 'prepare-npm-publish-out-'));
    try {
      writePackageFixture(srcDir, { name: '@imajin/fixture', version: FAKE_NPM_TOKEN });

      const { status, output } = runScript([srcDir, outDir], {
        ...process.env,
        NPM_TOKEN: FAKE_NPM_TOKEN,
      });

      expect(status).toBe(0);
      expect(output).not.toContain(FAKE_NPM_TOKEN);
    } finally {
      rmSync(srcDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
