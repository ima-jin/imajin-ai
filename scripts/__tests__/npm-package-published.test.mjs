/**
 * Tests for scripts/npm-package-published.mjs (#2578) — the skip-if-already-
 * published check scripts/publish-package.sh runs before `npm publish`.
 *
 * The registry is never contacted: `check` takes an injected `npm view`
 * runner, and the CLI/shell wiring is exercised against a fake `npm` on PATH.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, classifyNpmView, runNpmView } from '../npm-package-published.mjs';

const SCRIPT = fileURLToPath(new URL('../npm-package-published.mjs', import.meta.url));
const REGISTRY = 'https://registry.npmjs.org';

function preparedPackage(manifest = { name: '@ima-jin/logger', version: '0.8.14' }) {
  const dir = mkdtempSync(join(tmpdir(), 'npm-published-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  return dir;
}

/** A fake `npm` that prints/exits as told, recording its argv. */
function fakeNpmBin({ stdout = '', stderr = '', code = 0 }) {
  const bin = mkdtempSync(join(tmpdir(), 'fake-npm-'));
  mkdirSync(bin, { recursive: true });
  const file = join(bin, 'npm');
  writeFileSync(
    file,
    `#!/usr/bin/env bash\necho "$@" > "${bin}/argv"\nprintf '%s' ${JSON.stringify(stdout)}\nprintf '%s' ${JSON.stringify(stderr)} >&2\nexit ${code}\n`,
  );
  chmodSync(file, 0o755);
  return bin;
}

describe('classifyNpmView', () => {
  it('exit 0 with a version means the version is published', () => {
    expect(classifyNpmView({ status: 0, stdout: '"0.8.14"\n', stderr: '' })).toBe('published');
  });

  it('exit 0 with empty output is an error, never "published"', () => {
    expect(classifyNpmView({ status: 0, stdout: '  \n', stderr: '' })).toBe('error');
  });

  it.each([
    ['current npm', 'npm error code E404\nnpm error 404 No match found for version 0.8.14'],
    ['older npm', 'npm ERR! code E404\nnpm ERR! 404 Not Found'],
  ])('E404 (%s) means the version is not published', (_label, stderr) => {
    expect(classifyNpmView({ status: 1, stdout: '', stderr })).toBe('unpublished');
  });

  it.each([
    ['auth', 'npm error code E401'],
    ['forbidden', 'npm error code E403'],
    ['registry down', 'npm error code E503'],
    ['network', 'npm error code ENOTFOUND'],
    ['killed by signal', ''],
  ])('%s failures are errors, not "unpublished"', (_label, stderr) => {
    expect(classifyNpmView({ status: _label === 'killed by signal' ? null : 1, stdout: '', stderr })).toBe(
      'error',
    );
  });

  it('does not mistake a longer code that merely contains 404 for E404', () => {
    expect(classifyNpmView({ status: 1, stdout: '', stderr: 'npm error code E4040' })).toBe('error');
  });
});

describe('check', () => {
  it('looks up the prepared copy name@version on the given registry', () => {
    const calls = [];
    const result = check([preparedPackage(), REGISTRY], (name, version, registry) => {
      calls.push([name, version, registry]);
      return { status: 0, stdout: '"0.8.14"', stderr: '' };
    });

    expect(calls).toEqual([['@ima-jin/logger', '0.8.14', REGISTRY]]);
    expect(result).toEqual({ code: 0, out: 'published', err: '' });
  });

  it('reports unpublished (exit 0) when the registry answers 404, so the publish proceeds', () => {
    const result = check([preparedPackage(), REGISTRY], () => ({
      status: 1,
      stdout: '',
      stderr: 'npm error code E404',
    }));

    expect(result).toEqual({ code: 0, out: 'unpublished', err: '' });
  });

  it('fails (exit 1) when the state cannot be determined, naming the package and registry', () => {
    const result = check([preparedPackage(), REGISTRY], () => ({
      status: 1,
      stdout: '',
      stderr: 'npm error code E503\nservice unavailable',
    }));

    expect(result.code).toBe(1);
    expect(result.out).toBe('');
    expect(result.err).toContain('@ima-jin/logger@0.8.14');
    expect(result.err).toContain(REGISTRY);
    expect(result.err).toContain('E503');
  });

  it('falls back to stdout for the error detail when stderr is empty', () => {
    const result = check([preparedPackage(), REGISTRY], () => ({ status: 2, stdout: 'odd output', stderr: '' }));

    expect(result.code).toBe(1);
    expect(result.err).toContain('odd output');
  });

  it('requires both arguments', () => {
    expect(check([]).code).toBe(1);
    expect(check([preparedPackage()]).code).toBe(1);
    expect(check([]).err).toContain('usage');
  });

  it('fails when the package.json is missing or unparseable', () => {
    const empty = mkdtempSync(join(tmpdir(), 'npm-published-empty-'));
    expect(check([empty, REGISTRY]).err).toContain('cannot read');

    const broken = mkdtempSync(join(tmpdir(), 'npm-published-broken-'));
    writeFileSync(join(broken, 'package.json'), '{not json');
    expect(check([broken, REGISTRY]).code).toBe(1);
  });

  it.each([
    ['name', { version: '1.0.0' }],
    ['version', { name: '@ima-jin/x' }],
  ])('fails when the manifest has no %s', (_field, manifest) => {
    const result = check([preparedPackage(manifest), REGISTRY], () => {
      throw new Error('must not query the registry');
    });

    expect(result.code).toBe(1);
    expect(result.err).toContain('no name/version');
  });
});

describe('runNpmView', () => {
  it('runs `npm view <name>@<version> version --json --registry <url>` and returns its output', () => {
    const bin = fakeNpmBin({ stdout: '"0.8.14"' });
    const original = process.env.PATH;
    process.env.PATH = `${bin}:${original}`;
    try {
      const result = runNpmView('@ima-jin/logger', '0.8.14', REGISTRY);
      expect(result).toEqual({ status: 0, stdout: '"0.8.14"', stderr: '' });
    } finally {
      process.env.PATH = original;
    }

    const argv = execFileSync('cat', [join(bin, 'argv')], { encoding: 'utf8' }).trim();
    expect(argv).toBe(`view @ima-jin/logger@0.8.14 version --json --registry ${REGISTRY}`);
  });

  it('surfaces a spawn failure (npm not found) in stderr with a null status', () => {
    const original = process.env.PATH;
    process.env.PATH = mkdtempSync(join(tmpdir(), 'empty-path-'));
    try {
      const result = runNpmView('@ima-jin/logger', '0.8.14', REGISTRY);
      expect(result.status).toBeNull();
      expect(result.stderr).toContain('ENOENT');
    } finally {
      process.env.PATH = original;
    }
  });
});

describe('CLI', () => {
  function run(bin, dir) {
    return spawnSync(process.execPath, [SCRIPT, dir, REGISTRY], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  }

  it('prints `published` and exits 0 for a version already on the registry', () => {
    const result = run(fakeNpmBin({ stdout: '"0.8.14"' }), preparedPackage());
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('published');
  });

  it('prints `unpublished` and exits 0 on E404', () => {
    const result = run(fakeNpmBin({ stderr: 'npm error code E404', code: 1 }), preparedPackage());
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('unpublished');
  });

  it('exits 1 with a message on stderr (and nothing on stdout) when npm fails for another reason', () => {
    const result = run(fakeNpmBin({ stderr: 'npm error code E401', code: 1 }), preparedPackage());
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('cannot determine');
  });

  it('exits 1 with usage when called without arguments', () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('usage');
  });
});
