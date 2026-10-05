// check-vault-path-consistency.test.mjs (#2487)
//
// The deploy's provisioning step reads `node --env-file=apps/kernel/.env.local`;
// the running kernel gets VAULT_PATH from its pm2 env. When the two named
// different vault files, provisioning refused to continue on an empty one while
// the kernel held the real vault elsewhere. These tests pin the pre-deploy check
// that catches that, and that the checked-in ecosystem config alone resolves the
// same file the deploy provisions into.
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  KERNEL_PROCESS,
  ecosystemConfigPath,
  evaluateVaultPathSources,
  normalizeVaultPath,
  readEcosystemVaultPath,
  readEnvFileValue,
  readPm2VaultPath,
} from '../lib/vault-path-sources.mjs';

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const require_ = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(new URL('../check-vault-path-consistency.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const PROD_VAULT = '/srv/imajin/vault.prod.json';
const STALE_VAULT = '/srv/imajin/vault.json';
// Stands in for the real secrets pm2 keeps in a process env; must never be echoed.
const SECRET_SENTINEL = 'sentinel-secret-must-not-leak-0xDEADBEEF';

/** A fresh repo root with deploy/ and apps/kernel/ ready to populate. */
function makeRoot({ ecosystemVaultPath = PROD_VAULT, envLocal } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'vault-path-check-'));
  mkdirSync(join(root, 'deploy'), { recursive: true });
  mkdirSync(join(root, 'apps', 'kernel'), { recursive: true });
  for (const env of ['dev', 'prod']) {
    const env_ = ecosystemVaultPath ? { NODE_ENV: 'production', VAULT_PATH: ecosystemVaultPath } : { NODE_ENV: 'production' };
    const apps = [
      // A non-kernel app first with its OWN VAULT_PATH: must never be picked up.
      { name: `${env}-other`, env: { VAULT_PATH: '/srv/imajin/not-the-kernel.json' } },
      { name: KERNEL_PROCESS[env], env: env_ },
    ];
    writeFileSync(join(root, 'deploy', `ecosystem.${env}.config.js`), `module.exports = ${JSON.stringify({ apps })};\n`);
  }
  if (envLocal !== undefined) writeFileSync(join(root, 'apps', 'kernel', '.env.local'), envLocal);
  return root;
}

/** pm2 jlist for a running kernel, with unrelated secrets in its env like the real thing. */
function writeJlist(root, name, vaultPath) {
  const env = { AUTH_PRIVATE_KEY: SECRET_SENTINEL, DATABASE_URL: `postgres://u:${SECRET_SENTINEL}@h/db` };
  if (vaultPath) env.VAULT_PATH = vaultPath;
  const file = join(root, 'jlist.json');
  writeFileSync(file, JSON.stringify([{ name: 'unrelated', pm2_env: { VAULT_PATH: '/x/other.json' } }, { name, pm2_env: env }]));
  return file;
}

function runCheck(root, { env = 'prod', jlist, shellVaultPath, extraArgs = [] } = {}) {
  const args = [SCRIPT, '--env', env, '--root', root, ...extraArgs];
  if (jlist) args.push('--pm2-jlist-file', jlist);
  const childEnv = { ...process.env, GITHUB_STEP_SUMMARY: join(root, 'summary.md') };
  delete childEnv.VAULT_PATH;
  if (shellVaultPath) childEnv.VAULT_PATH = shellVaultPath;
  try {
    const stdout = execFileSync(process.execPath, args, { env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    return { status: error.status, stdout: String(error.stdout), stderr: String(error.stderr) };
  }
}

function summaryOf(root) {
  return readFileSync(join(root, 'summary.md'), 'utf8');
}

describe('check-vault-path-consistency CLI', () => {
  it('passes when ecosystem, .env.local and the running kernel agree (no VAULT_PATH in .env.local)', () => {
    const root = makeRoot({ envLocal: 'DATABASE_URL="postgres://x"\n' });
    const result = runCheck(root, { jlist: writeJlist(root, 'prod-jin', PROD_VAULT) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(PROD_VAULT);
    expect(result.stdout).toContain('OK');
  });

  it('fails naming both paths when .env.local sets a different VAULT_PATH (the #2487 incident)', () => {
    const root = makeRoot({ envLocal: `VAULT_PATH=${STALE_VAULT}\n` });
    const result = runCheck(root, { jlist: writeJlist(root, 'prod-jin', PROD_VAULT) });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`the provisioning step would use ${STALE_VAULT} but the running prod-jin uses ${PROD_VAULT}`);
    expect(result.stdout).toContain(`apps/kernel/.env.local sets VAULT_PATH=${STALE_VAULT}`);
    expect(result.stdout).toContain('FAIL');
  });

  it('fails when the running kernel (pm2 env) differs from the ecosystem config', () => {
    const root = makeRoot({ envLocal: '' });
    const result = runCheck(root, { jlist: writeJlist(root, 'prod-jin', STALE_VAULT) });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(STALE_VAULT);
    expect(result.stdout).toContain(PROD_VAULT);
    expect(result.stdout).toContain('restart from the ecosystem config alone resolves');
  });

  it('fails when a shell VAULT_PATH overrides the provisioner away from the ecosystem file', () => {
    const root = makeRoot();
    const result = runCheck(root, { jlist: writeJlist(root, 'prod-jin', PROD_VAULT), shellVaultPath: STALE_VAULT });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(STALE_VAULT);
    expect(result.stdout).toContain(PROD_VAULT);
  });

  it('fails when the ecosystem config does not define VAULT_PATH for the kernel', () => {
    const root = makeRoot({ ecosystemVaultPath: null });
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('does not set VAULT_PATH');
  });

  it('only warns when .env.local repeats the ecosystem value', () => {
    const root = makeRoot({ envLocal: `VAULT_PATH="${PROD_VAULT}" # same file\n` });
    const result = runCheck(root, { jlist: writeJlist(root, 'prod-jin', PROD_VAULT) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('WARNING');
  });

  it('skips the running-kernel comparison when the kernel is not running (first deploy)', () => {
    const root = makeRoot({ envLocal: '' });
    const result = runCheck(root, { jlist: writeJlist(root, 'some-other-process', STALE_VAULT) });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('not running');
  });

  it('checks the dev kernel (dev-jin) against the dev ecosystem', () => {
    const root = makeRoot({ ecosystemVaultPath: '/srv/imajin/vault.dev.json' });
    expect(runCheck(root, { env: 'dev', jlist: writeJlist(root, 'dev-jin', '/srv/imajin/vault.dev.json') }).status).toBe(0);
    const mismatch = runCheck(root, { env: 'dev', jlist: writeJlist(root, 'dev-jin', PROD_VAULT) });
    expect(mismatch.status).toBe(1);
    expect(mismatch.stdout).toContain('dev-jin');
  });

  it('can read the live ecosystem file instead of the repo copy (--ecosystem-file)', () => {
    const root = makeRoot();
    const live = join(root, 'live-ecosystem.config.js');
    writeFileSync(live, `module.exports = { apps: [{ name: 'prod-jin', env: { VAULT_PATH: '${STALE_VAULT}' } }] };\n`);
    const result = runCheck(root, { jlist: writeJlist(root, 'prod-jin', PROD_VAULT), extraArgs: ['--ecosystem-file', live] });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(STALE_VAULT);
  });

  it('never prints or records any pm2 env value other than the vault path', () => {
    const root = makeRoot({ envLocal: `VAULT_PATH=${STALE_VAULT}\n` });
    const result = runCheck(root, { jlist: writeJlist(root, 'prod-jin', PROD_VAULT) });
    expect(result.status).toBe(1);
    for (const text of [result.stdout, result.stderr, summaryOf(root)]) {
      expect(text).not.toContain(SECRET_SENTINEL);
      expect(text).not.toContain('AUTH_PRIVATE_KEY');
    }
    expect(summaryOf(root)).toContain(STALE_VAULT);
  });

  it('does not echo malformed pm2 output (it is a dump of process environments)', () => {
    const root = makeRoot();
    const bad = join(root, 'bad.json');
    writeFileSync(bad, `not json ${SECRET_SENTINEL}`);
    const result = runCheck(root, { jlist: bad });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not valid JSON');
    expect(result.stderr).not.toContain(SECRET_SENTINEL);
  });

  it('rejects an unknown --env', () => {
    expect(runCheck(makeRoot(), { env: 'staging' }).status).toBe(2);
  });
});

describe('vault-path-sources helpers', () => {
  it('normalises `~`, whitespace and equivalent spellings to one absolute path', () => {
    expect(normalizeVaultPath('~/.imajin/vault.prod.json', '/home/jin')).toBe('/home/jin/.imajin/vault.prod.json');
    expect(normalizeVaultPath('  /home/jin/.imajin//vault.prod.json ', '/home/jin')).toBe('/home/jin/.imajin/vault.prod.json');
    expect(normalizeVaultPath('~', '/home/jin')).toBe('/home/jin');
    expect(normalizeVaultPath('   ')).toBeUndefined();
    expect(normalizeVaultPath(undefined)).toBeUndefined();
  });

  it('parses dotenv values like node --env-file (quotes, comments, export, last wins, blank = unset)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vault-path-env-'));
    const file = join(dir, '.env.local');
    writeFileSync(file, ['# VAULT_PATH=/commented', 'OTHER=1', 'export VAULT_PATH=/first', "VAULT_PATH='/second' # c", ''].join('\n'));
    expect(readEnvFileValue(file, 'VAULT_PATH')).toBe('/second');
    writeFileSync(file, 'VAULT_PATH=/a/b # trailing\n');
    expect(readEnvFileValue(file, 'VAULT_PATH')).toBe('/a/b');
    writeFileSync(file, 'VAULT_PATH=""\n');
    expect(readEnvFileValue(file, 'VAULT_PATH')).toBeUndefined();
    expect(readEnvFileValue(join(dir, 'missing'), 'VAULT_PATH')).toBeUndefined();
  });

  it('treats an .env.local-only running kernel as reading that file', () => {
    const result = evaluateVaultPathSources({
      envName: 'prod',
      processName: 'prod-jin',
      ecosystem: PROD_VAULT,
      envLocal: STALE_VAULT,
      running: { running: true, vaultPath: undefined },
    });
    expect(result.errors.join('\n')).toContain(STALE_VAULT);
    const none = evaluateVaultPathSources({
      envName: 'prod',
      processName: 'prod-jin',
      ecosystem: PROD_VAULT,
      running: { running: true, vaultPath: undefined },
    });
    expect(none.errors.join('\n')).toContain('has no VAULT_PATH');
  });

  it('reads only VAULT_PATH out of pm2 jlist output', () => {
    const jlist = JSON.stringify([{ name: 'prod-jin', pm2_env: { VAULT_PATH: ' /v.json ', AUTH_PRIVATE_KEY: SECRET_SENTINEL } }]);
    expect(readPm2VaultPath(jlist, 'prod-jin')).toEqual({ running: true, vaultPath: '/v.json' });
    expect(readPm2VaultPath(jlist, 'dev-jin')).toEqual({ running: false, vaultPath: undefined });
    expect(readPm2VaultPath('{}', 'prod-jin').running).toBe(false);
  });
});

describe('checked-in deploy config (#2487)', () => {
  it('declares a distinct VAULT_PATH for dev-jin and prod-jin in the ecosystem configs', () => {
    const dev = readEcosystemVaultPath(ecosystemConfigPath(REPO_ROOT, 'dev'), 'dev');
    const prod = readEcosystemVaultPath(ecosystemConfigPath(REPO_ROOT, 'prod'), 'prod');
    expect(dev).toBe('~/.imajin/vault.dev.json');
    expect(prod).toBe('~/.imajin/vault.prod.json');
    expect(normalizeVaultPath(dev)).not.toBe(normalizeVaultPath(prod));
  });

  it('passes the check against the checked-in ecosystem configs with a clean .env.local', () => {
    for (const env of ['dev', 'prod']) {
      const root = makeRoot({ envLocal: 'DATABASE_URL="postgres://x"\n' });
      const real = readEcosystemVaultPath(ecosystemConfigPath(REPO_ROOT, env), env);
      const ecosystemFile = ecosystemConfigPath(REPO_ROOT, env);
      const result = runCheck(root, { env, jlist: writeJlist(root, KERNEL_PROCESS[env], real), extraArgs: ['--ecosystem-file', ecosystemFile] });
      expect(result.status, result.stdout).toBe(0);
    }
  });

  it('a restart from the ecosystem env alone resolves the file the provisioner uses', async () => {
    const { resolveVaultPath, _resetVaultPathCacheForTests } = await import('../../apps/kernel/src/lib/vault/vault-path.ts');
    const saved = { VAULT_PATH: process.env.VAULT_PATH, NODE_ENV: process.env.NODE_ENV };
    try {
      for (const env of ['dev', 'prod']) {
        const ecosystemEnv = require_(ecosystemConfigPath(REPO_ROOT, env)).apps.find((a) => a.name === KERNEL_PROCESS[env]).env;
        process.env.VAULT_PATH = ecosystemEnv.VAULT_PATH;
        process.env.NODE_ENV = ecosystemEnv.NODE_ENV;
        _resetVaultPathCacheForTests();
        const kernelResolves = resolveVaultPath();

        const { paths } = evaluateVaultPathSources({
          envName: env,
          processName: KERNEL_PROCESS[env],
          ecosystem: readEcosystemVaultPath(ecosystemConfigPath(REPO_ROOT, env), env),
        });
        expect(resolve(kernelResolves)).toBe(paths.provisioner);
        expect(paths.provisioner).toBe(join(homedir(), '.imajin', `vault.${env}.json`));
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      _resetVaultPathCacheForTests();
    }
  });

  it('does not declare VAULT_PATH in apps/kernel/.env.example (it would be required in .env.local)', () => {
    const example = readFileSync(join(REPO_ROOT, 'apps', 'kernel', '.env.example'), 'utf8');
    const declared = example.split(/\r?\n/).some((line) => line.trim().startsWith('VAULT_PATH'));
    expect(declared).toBe(false);
  });

  for (const [workflow, env] of [
    ['deploy-prod.yml', 'prod'],
    ['deploy-dev.yml', 'dev'],
  ]) {
    it(`${workflow} runs the check, against the live ecosystem file, before provisioning`, () => {
      const text = readFileSync(join(REPO_ROOT, '.github', 'workflows', workflow), 'utf8');
      const check = text.indexOf(`check-vault-path-consistency.mjs --env ${env} --pm2-jlist-file`);
      const provision = text.indexOf('scripts/provision-service-bootstrap.mjs');
      expect(check).toBeGreaterThan(-1);
      expect(provision).toBeGreaterThan(check);
      expect(text).toContain('--ecosystem-file "$ECOSYSTEM_FILE"');
    });
  }
});
