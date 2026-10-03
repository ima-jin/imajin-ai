import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `.pathname`: on Windows the latter yields "/D:/...", which
// node then resolves against the cwd into "C:\D:\..." and cannot load.
const SCRIPT = fileURLToPath(new URL('../check-env.ts', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

// Real service name from packages/config/src/services.ts — check-env.ts
// imports that manifest directly (not from CHECK_ENV_ROOT), so every
// fixture below has to reuse a name it already knows. "events" (devPort
// 3006, tier "core") is a plain, non-daemon service with no special-cased
// behaviour, so it's the default stand-in for the key-annotation scenarios;
// the deploy-target scenarios exercise it against a synthetic ecosystem file.
const SERVICE = 'events';

/** A fresh CHECK_ENV_ROOT with apps/<SERVICE>/ and deploy/ ready to populate. */
function makeRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'check-env-test-'));
  mkdirSync(join(dir, 'apps', SERVICE), { recursive: true });
  mkdirSync(join(dir, 'deploy'), { recursive: true });
  return dir;
}

function writeExample(dir, content) {
  writeFileSync(join(dir, 'apps', SERVICE, '.env.example'), content, 'utf8');
}

/** Writing a .env.local (even empty) is what makes hasEnvLocal true. */
function writeLocal(dir, content = '') {
  writeFileSync(join(dir, 'apps', SERVICE, '.env.local'), content, 'utf8');
}

/** A minimal deploy/ecosystem.<env>.config.js listing exactly `appNames` as pm2 targets. */
function writeEcosystem(dir, env, appNames) {
  const apps = appNames
    .map((name) => `    { "name": "${env}-${name}", "cwd": "/home/jin/${env}/imajin-ai/apps/${name}" }`)
    .join(',\n');
  writeFileSync(
    join(dir, 'deploy', `ecosystem.${env}.config.js`),
    `module.exports = {\n  "apps": [\n${apps}\n  ]\n};\n`,
    'utf8',
  );
}

function run(dir, args) {
  try {
    const stdout = execFileSync('pnpm', ['exec', 'tsx', SCRIPT, ...args], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: { ...process.env, CHECK_ENV_ROOT: dir },
    });
    return { stdout, status: 0 };
  } catch (e) {
    return {
      stdout: (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? ''),
      status: e.status ?? 1,
    };
  }
}

describe('check-env annotations', () => {
  it('required-missing -> error', () => {
    const dir = makeRoot();
    writeExample(dir, 'REQUIRED_KEY=\n');
    writeLocal(dir, '');

    const result = run(dir, ['--env', 'dev', SERVICE]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('missing');
    expect(result.stdout).toContain('REQUIRED_KEY');
  });

  it('optional-missing -> ok (+warn)', () => {
    const dir = makeRoot();
    writeExample(dir, '# optional\nOPTIONAL_KEY=\n');
    writeLocal(dir, '');

    const result = run(dir, ['--env', 'dev', SERVICE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('optional, not set');
    expect(result.stdout).toContain('OPTIONAL_KEY');
  });

  it('vault-sourced-missing -> ok', () => {
    const dir = makeRoot();
    writeExample(dir, '# vault-sourced: fetched at boot via loadFromVault, do not set locally\nVAULT_KEY=\n');
    writeLocal(dir, '');

    const result = run(dir, ['--env', 'dev', SERVICE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('all good');
    expect(result.stdout).not.toContain('VAULT_KEY');
  });

  it('vault-sourced-present -> warn', () => {
    const dir = makeRoot();
    writeExample(dir, '# vault-sourced: fetched at boot via loadFromVault, do not set locally\nVAULT_KEY=\n');
    writeLocal(dir, 'VAULT_KEY=hand-provisioned-value\n');

    const result = run(dir, ['--env', 'dev', SERVICE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('vault-sourced');
    expect(result.stdout).toContain('VAULT_KEY');
    expect(result.stdout).toContain('deprecated hand-provisioned value present; remove after rotation');
  });

  it('deprecated-present -> warn', () => {
    const dir = makeRoot();
    writeExample(dir, '# deprecated: legacy fallback, remove after migration\nDEPRECATED_KEY=\n');
    writeLocal(dir, 'DEPRECATED_KEY=still-set\n');

    const result = run(dir, ['--env', 'dev', SERVICE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('deprecated');
    expect(result.stdout).toContain('DEPRECATED_KEY');
    expect(result.stdout).toContain('legacy fallback, remove after migration');
  });

  it('deprecated-missing -> ok, no warning', () => {
    const dir = makeRoot();
    writeExample(dir, '# deprecated: legacy fallback, remove after migration\nDEPRECATED_KEY=\n');
    writeLocal(dir, '');

    const result = run(dir, ['--env', 'dev', SERVICE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('all good');
  });

  it('a truly required key next to annotated ones still hard-errors (no regression)', () => {
    const dir = makeRoot();
    writeExample(
      dir,
      '# optional\nOPTIONAL_KEY=\n# vault-sourced: fetched at boot\nVAULT_KEY=\nREQUIRED_KEY=\n',
    );
    writeLocal(dir, '');

    const result = run(dir, ['--env', 'dev', SERVICE]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('missing');
    expect(result.stdout).toContain('REQUIRED_KEY');
    // The annotated keys must not also be reported as hard-missing errors.
    expect(result.stdout).not.toMatch(/missing.*OPTIONAL_KEY/);
    expect(result.stdout).not.toMatch(/missing.*VAULT_KEY/);
  });
});

describe('check-env per-env deploy targets', () => {
  it('service-not-in-target with no .env.local -> ok (warn)', () => {
    const dir = makeRoot();
    writeExample(dir, 'SOME_KEY=\n');
    writeEcosystem(dir, 'dev', ['kernel']); // deliberately excludes SERVICE
    // No .env.local written at all.

    const result = run(dir, ['--env', 'dev', SERVICE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('not a deploy target for this env');
  });

  it('service-in-target with no .env.local -> error', () => {
    const dir = makeRoot();
    writeExample(dir, 'SOME_KEY=\n');
    writeEcosystem(dir, 'dev', ['kernel', SERVICE]);
    // No .env.local written at all.

    const result = run(dir, ['--env', 'dev', SERVICE]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("required for this env's deploy target");
  });

  it('the same service can be a target in one env and not the other (mirrors corpus prod/dev, #2246/#2232)', () => {
    const dir = makeRoot();
    writeExample(dir, 'SOME_KEY=\n');
    writeEcosystem(dir, 'dev', [SERVICE]);
    writeEcosystem(dir, 'prod', ['kernel']); // SERVICE excluded from prod

    const devResult = run(dir, ['--env', 'dev', SERVICE]);
    expect(devResult.status).toBe(1);
    expect(devResult.stdout).toContain("required for this env's deploy target");

    const prodResult = run(dir, ['--env', 'prod', SERVICE]);
    expect(prodResult.status).toBe(0);
    expect(prodResult.stdout).toContain('not a deploy target for this env');
  });

  it("falls back to today's heuristic when no ecosystem file is present (unreadable manifest)", () => {
    const dir = makeRoot();
    writeExample(dir, 'SOME_KEY=\n');
    // No deploy/ecosystem.*.config.js written at all — "events" has a
    // non-zero devPort, so the pre-#2246 heuristic treats it as a target.

    const result = run(dir, ['--env', 'dev', SERVICE]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("required for this env's deploy target");
  });
});

// ── Vault file check (#2412) ────────────────────────────────────────────────
//
// A configured VAULT_PATH whose file is absent must stop the deploy here, before
// pm2 restarts the kernel into an empty vault. VAULT_PATH lives in the pm2
// ecosystem file (not .env.local), so these fixtures write it there; the
// process-env override is exercised separately.

/** A CHECK_ENV_ROOT whose only checked service is a clean, env-satisfied kernel. */
function makeKernelRoot({ vaultPath, extraEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'check-env-vault-test-'));
  mkdirSync(join(dir, 'apps', 'kernel'), { recursive: true });
  mkdirSync(join(dir, 'deploy'), { recursive: true });
  writeFileSync(join(dir, 'apps', 'kernel', '.env.example'), '', 'utf8');
  writeFileSync(join(dir, 'apps', 'kernel', '.env.local'), '', 'utf8');

  const envEntries = { ...extraEnv };
  if (vaultPath !== undefined) envEntries.VAULT_PATH = vaultPath;
  const envBlock = Object.entries(envEntries)
    .map(([key, value]) => `        "${key}": "${value}"`)
    .join(',\n');
  writeFileSync(
    join(dir, 'deploy', 'ecosystem.dev.config.js'),
    `module.exports = {\n  "apps": [\n    { "name": "dev-jin", "cwd": "/home/jin/dev/imajin-ai/apps/kernel", "env": {\n${envBlock}\n    } }\n  ]\n};\n`,
    'utf8',
  );
  return dir;
}

function runKernel(dir, envOverrides = {}) {
  const baseEnv = { ...process.env, CHECK_ENV_ROOT: dir };
  delete baseEnv.VAULT_PATH;
  delete baseEnv.VAULT_ALLOW_BOOTSTRAP;
  try {
    const stdout = execFileSync('pnpm', ['exec', 'tsx', SCRIPT, '--env', 'dev', 'kernel'], {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: { ...baseEnv, ...envOverrides },
    });
    return { stdout, status: 0 };
  } catch (e) {
    return {
      stdout: (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? ''),
      status: e.status ?? 1,
    };
  }
}

describe('check-env vault file (#2412)', () => {
  it('fails when the configured VAULT_PATH file does not exist', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'check-env-vault-empty-')), 'vault.dev.json');
    const dir = makeKernelRoot({ vaultPath: missing });

    const result = runKernel(dir);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('VAULT_PATH file does not exist');
    expect(result.stdout).toContain(missing);
  });

  it('passes when the configured VAULT_PATH file exists', () => {
    const vaultDir = mkdtempSync(join(tmpdir(), 'check-env-vault-present-'));
    const present = join(vaultDir, 'vault.dev.json');
    writeFileSync(present, '{"version":1,"entries":[]}', 'utf8');
    const dir = makeKernelRoot({ vaultPath: present });

    const result = runKernel(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('vault file present');
  });

  it('fails on a deliberately wrong VAULT_PATH from the process env, overriding the ecosystem file', () => {
    const vaultDir = mkdtempSync(join(tmpdir(), 'check-env-vault-override-'));
    const good = join(vaultDir, 'vault.dev.json');
    writeFileSync(good, '{"version":1,"entries":[]}', 'utf8');
    const dir = makeKernelRoot({ vaultPath: good });

    const result = runKernel(dir, { VAULT_PATH: join(vaultDir, 'vault.typo.json') });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('vault.typo.json');
  });

  it('expands a leading ~ against the home directory, like the kernel does', () => {
    const home = mkdtempSync(join(tmpdir(), 'check-env-vault-home-'));
    mkdirSync(join(home, '.imajin'), { recursive: true });
    writeFileSync(join(home, '.imajin', 'vault.dev.json'), '{"version":1,"entries":[]}', 'utf8');
    const dir = makeKernelRoot({ vaultPath: '~/.imajin/vault.dev.json' });

    expect(runKernel(dir, { HOME: home, USERPROFILE: home }).status).toBe(0);

    const emptyHome = mkdtempSync(join(tmpdir(), 'check-env-vault-nohome-'));
    expect(runKernel(dir, { HOME: emptyHome, USERPROFILE: emptyHome }).status).toBe(1);
  });

  it('allows a missing file (warning only) when the explicit bootstrap flag is set', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'check-env-vault-bootstrap-')), 'vault.dev.json');
    const dir = makeKernelRoot({ vaultPath: missing });

    const result = runKernel(dir, { VAULT_ALLOW_BOOTSTRAP: '1' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('VAULT_ALLOW_BOOTSTRAP is set');
  });

  it('reads the bootstrap flag from the ecosystem file too', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'check-env-vault-eco-bootstrap-')), 'vault.dev.json');
    const dir = makeKernelRoot({ vaultPath: missing, extraEnv: { VAULT_ALLOW_BOOTSTRAP: 'true' } });

    expect(runKernel(dir).status).toBe(0);
  });

  it('does not treat VAULT_ALLOW_BOOTSTRAP=0 as a bootstrap request', () => {
    const missing = join(mkdtempSync(join(tmpdir(), 'check-env-vault-zero-')), 'vault.dev.json');
    const dir = makeKernelRoot({ vaultPath: missing });

    expect(runKernel(dir, { VAULT_ALLOW_BOOTSTRAP: '0' }).status).toBe(1);
  });

  it('skips the vault check when no VAULT_PATH is configured anywhere', () => {
    const dir = makeKernelRoot();

    const result = runKernel(dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('VAULT_PATH not set');
  });

  it('does not check the vault when the kernel is not among the checked services', () => {
    const dir = makeRoot();
    writeExample(dir, '');
    writeLocal(dir, '');

    const result = run(dir, ['--env', 'dev', SERVICE]);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('vault');
  });
});

// ── CRON_SECRET (#2550) ─────────────────────────────────────────────────────
//
// Every kernel cron route fails closed without it and the cron scheduler will
// not start, so a deploy without a real value must stop here, before restart.

function makeCronRoot(localContent) {
  const dir = makeKernelRoot();
  writeFileSync(join(dir, 'apps', 'kernel', '.env.example'), 'CRON_SECRET=""\n', 'utf8');
  writeFileSync(join(dir, 'apps', 'kernel', '.env.local'), localContent, 'utf8');
  return dir;
}

describe('check-env CRON_SECRET (#2550)', () => {
  it('fails the deploy when CRON_SECRET is missing from the kernel .env.local', () => {
    const result = runKernel(makeCronRoot(''));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('missing');
    expect(result.stdout).toContain('CRON_SECRET');
  });

  it('fails the deploy when CRON_SECRET is present but empty', () => {
    const result = runKernel(makeCronRoot('CRON_SECRET=""\n'));
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('CRON_SECRET (empty)');
  });

  it('passes when CRON_SECRET has a value', () => {
    const result = runKernel(makeCronRoot('CRON_SECRET=not-a-real-value\n'));
    expect(result.status).toBe(0);
  });

  it("declares CRON_SECRET in the kernel's real .env.example with no optional/vault-sourced annotation", () => {
    const lines = readFileSync(join(REPO_ROOT, 'apps', 'kernel', '.env.example'), 'utf8').split('\n');
    const index = lines.findIndex((line) => line.startsWith('CRON_SECRET='));
    expect(index).toBeGreaterThan(-1);
    // check-env treats a recognised annotation comment directly above a key as
    // "not required"; it must not be present here.
    expect(lines[index - 1]).not.toMatch(/^#\s*(optional|vault-sourced|deprecated)/);
  });
});
