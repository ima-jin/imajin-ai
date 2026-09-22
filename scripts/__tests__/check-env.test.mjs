import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
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
