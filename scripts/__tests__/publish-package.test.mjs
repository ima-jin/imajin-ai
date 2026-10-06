/**
 * Tests for the npmjs.org auth flow in scripts/publish-package.sh (#1589):
 * OIDC Trusted Publishing first, `--provenance`, and an optional legacy-token
 * fallback.
 *
 * Nothing real is contacted or published: a fake `npm` placed first on PATH
 * records how it was invoked (args, which npm user config it was pointed at,
 * which credential env vars it could see) and fails a configurable number of
 * times, and a throwaway local HTTP server stands in for the registry so the
 * "already published?" lookup (scripts/npm-package-published.mjs) resolves
 * without network access. The registry URL contains `registry.npmjs.org` so
 * the script takes its npmjs branch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const SCRIPT = fileURLToPath(new URL('../publish-package.sh', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGES_ROOT = join(REPO_ROOT, 'packages');

// Generated per run so no credential-shaped literal lives in the repo.
const FALLBACK_TOKEN = randomUUID();
const PLACEHOLDER_TOKEN = randomUUID();

const FAKE_NPM = `#!/usr/bin/env bash
{
  echo "ARGS: $*"
  echo "NODE_AUTH_TOKEN_SET: \${NODE_AUTH_TOKEN+yes}"
  echo "FALLBACK_AUTH_SET: \${NPM_FALLBACK_AUTH:+yes}"
  echo "NPMRC<<"
  cat "$NPM_CONFIG_USERCONFIG"
  echo ">>"
} >> "$FAKE_NPM_LOG"
attempt="$(grep -c '^ARGS:' "$FAKE_NPM_LOG")"
if [[ "\${FAKE_NPM_FAIL_ATTEMPTS:-0}" -ge "$attempt" ]]; then
  echo "fake npm: simulated failure on attempt $attempt" >&2
  exit 1
fi
exit 0
`;

let registry; // local HTTP server standing in for the registry
let registryUrl;
let binDir;
const cleanups = [];

beforeAll(async () => {
  // 404 for every packument => "unpublished", so the script proceeds to publish.
  registry = createServer((_req, res) => {
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => registry.listen(0, '127.0.0.1', r));
  registryUrl = `http://127.0.0.1:${registry.address().port}/registry.npmjs.org`;

  binDir = mkdtempSync(join(tmpdir(), 'fake-npm-bin-'));
  writeFileSync(join(binDir, 'npm'), FAKE_NPM);
  chmodSync(join(binDir, 'npm'), 0o755);
});

afterAll(async () => {
  await new Promise((r) => registry.close(r));
  rmSync(binDir, { recursive: true, force: true });
  for (const dir of cleanups) rmSync(dir, { recursive: true, force: true });
});

function makePackage(manifest = {}) {
  const dir = mkdtempSync(join(PACKAGES_ROOT, '.tmp-publish-package-'));
  cleanups.push(dir);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@imajin/fixture', version: '1.2.3', private: true, ...manifest }),
  );
  return dir;
}

// Async on purpose: the fake registry lives in this process, so a blocking
// spawnSync would stop it answering the script's lookup and deadlock.
async function runPublish({ pkgDir, dryRun = 'false', env = {} }) {
  const logDir = mkdtempSync(join(tmpdir(), 'fake-npm-log-'));
  cleanups.push(logDir);
  const log = join(logDir, 'npm.log');
  writeFileSync(log, '');
  // Mirrors what actions/setup-node leaves behind in a real job.
  const baseEnv = {
    PATH: `${binDir}:${process.env.PATH}`,
    HOME: process.env.HOME,
    FAKE_NPM_LOG: log,
    NODE_AUTH_TOKEN: PLACEHOLDER_TOKEN,
  };
  const result = await execFileAsync(
    'bash',
    [SCRIPT, pkgDir.split('/').pop(), registryUrl, dryRun],
    { encoding: 'utf8', env: { ...baseEnv, ...env } },
  ).catch((e) => e);
  const status = typeof result.code === 'number' ? result.code : 0;
  return {
    status,
    output: `${result.stdout}${result.stderr}`,
    calls: readFileSync(log, 'utf8')
      .split('ARGS: ')
      .slice(1)
      .map((c) => `ARGS: ${c}`),
  };
}

describe('publish-package.sh — npmjs.org OIDC Trusted Publishing (#1589)', () => {
  it('publishes with --provenance over OIDC: no credential visible to npm', async () => {
    const { status, output, calls } = await runPublish({ pkgDir: makePackage() });

    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--provenance');
    expect(calls[0]).toContain('--access public');
    // Neither the setup-node placeholder nor any token reaches the OIDC attempt.
    expect(calls[0]).toContain('NODE_AUTH_TOKEN_SET: \n');
    expect(calls[0]).toContain('FALLBACK_AUTH_SET: \n');
    // The npm user config it ran with carries no _authToken line at all.
    expect(calls[0]).not.toMatch(/_authToken/);
    expect(output).toContain('Authenticated via OIDC Trusted Publishing');
    expect(output).not.toContain(PLACEHOLDER_TOKEN);
  });

  it('fails when OIDC fails and no fallback token is configured', async () => {
    const { status, output, calls } = await runPublish({
      pkgDir: makePackage(),
      env: { FAKE_NPM_FAIL_ATTEMPTS: '5' },
    });

    expect(status).not.toBe(0);
    expect(calls).toHaveLength(1);
    expect(output).toContain('no NPM_TOKEN fallback is configured');
    expect(output).not.toContain('Published @');
  });

  it('retries with the legacy token when OIDC fails and a fallback is configured', async () => {
    const { status, output, calls } = await runPublish({
      pkgDir: makePackage(),
      env: { FAKE_NPM_FAIL_ATTEMPTS: '1', NPM_FALLBACK_TOKEN: FALLBACK_TOKEN },
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(2);
    // Attempt 1: OIDC, token-free. Attempt 2: token, still with provenance.
    expect(calls[0]).toContain('FALLBACK_AUTH_SET: \n');
    expect(calls[0]).not.toMatch(/_authToken/);
    expect(calls[1]).toContain('--provenance');
    expect(calls[1]).toContain('FALLBACK_AUTH_SET: yes');
    // The token is passed to npm via env expansion, never written to the file.
    expect(calls[1]).toContain('//127.0.0.1:');
    expect(calls[1]).toContain('/:_authToken=${NPM_FALLBACK_AUTH}');
    expect(calls[1]).not.toContain(FALLBACK_TOKEN);
    expect(output).toContain('retrying with the legacy NPM_TOKEN fallback');
    expect(output).toContain('Authenticated via legacy NPM_TOKEN fallback');
    expect(output).not.toContain(FALLBACK_TOKEN);
  });

  it('does not touch the fallback token when OIDC succeeds', async () => {
    const { status, calls, output } = await runPublish({
      pkgDir: makePackage(),
      env: { NPM_FALLBACK_TOKEN: FALLBACK_TOKEN },
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('FALLBACK_AUTH_SET: \n');
    expect(output).not.toContain('legacy NPM_TOKEN');
    expect(output).not.toContain(FALLBACK_TOKEN);
  });

  it('dry run uses the credential-free config and never retries', async () => {
    const { status, calls } = await runPublish({
      pkgDir: makePackage(),
      dryRun: 'true',
      env: { FAKE_NPM_FAIL_ATTEMPTS: '5', NPM_FALLBACK_TOKEN: FALLBACK_TOKEN },
    });

    expect(status).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('--dry-run');
    expect(calls[0]).toContain('--provenance');
    expect(calls[0]).not.toMatch(/_authToken/);
  });

  it('adds repository metadata to the publish copy when the manifest omits it', async () => {
    const pkgDir = makePackage();
    const { status, output } = await runPublish({ pkgDir, dryRun: 'true' });

    expect(status).toBe(0);
    expect(output).toContain('Added repository metadata');
    expect(output).toContain('git+https://github.com/ima-jin/imajin-ai.git');
    expect(output).toContain(`"directory": "packages/${pkgDir.split('/').pop()}"`);
  });

  it('keeps an existing repository field untouched', async () => {
    const repository = {
      type: 'git',
      url: 'git+https://github.com/ima-jin/imajin-ai.git',
      directory: 'packages/custom',
    };
    const { status, output } = await runPublish({
      pkgDir: makePackage({ repository }),
      dryRun: 'true',
    });

    expect(status).toBe(0);
    expect(output).not.toContain('Added repository metadata');
    expect(output).toContain('"directory": "packages/custom"');
  });
});
