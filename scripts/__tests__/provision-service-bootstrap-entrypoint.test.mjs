import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { importTsAsEsm } from '../lib/import-ts-as-esm.mjs';

// #2483: scripts/provision-service-bootstrap.mjs must run as ESM. The deploy
// step used to run a .ts entrypoint through `tsx`, which compiles it (and the
// kernel sources it imports) to CommonJS, so every ESM-only transitive
// dependency (@ipld/dag-cbor) failed with `No "exports" main defined`.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entrypoint = join(repoRoot, 'scripts', 'provision-service-bootstrap.mjs');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');

const tmpRoots = [];
afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

function makeTmp() {
  const root = mkdtempSync(join(tmpdir(), 'provision-esm-test-'));
  tmpRoots.push(root);
  return root;
}

function runEntrypoint(args, { cwd = repoRoot, env = {} } = {}) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production', ...env },
  });
}

describe('importTsAsEsm', () => {
  /** A temp project: an ESM-only dependency (an `import`-only export map, like @ipld/dag-cbor) and a typeless-package .ts entry using it. */
  function makeProjectWithEsmOnlyDep() {
    const root = makeTmp();
    const dep = join(root, 'node_modules', 'esm-only-dep');
    mkdirSync(dep, { recursive: true });
    writeFileSync(
      join(dep, 'package.json'),
      JSON.stringify({ name: 'esm-only-dep', type: 'module', exports: { '.': { import: './index.js' } } }),
    );
    writeFileSync(join(dep, 'index.js'), 'export const answer = 42;\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture' })); // no "type": "module"
    const entry = join(root, 'entry.ts');
    writeFileSync(entry, "import { answer } from 'esm-only-dep';\nexport const value: number = answer;\n");
    return { root, entry };
  }

  it('loads an ESM-only dependency (import-only export map) from a typeless-package .ts entry', async () => {
    const { entry } = makeProjectWithEsmOnlyDep();
    const loaded = await importTsAsEsm(entry);
    expect(loaded.value).toBe(42);
  });

  it('control: the same entry under tsx (CommonJS) fails exactly like #2483', () => {
    const { root, entry } = makeProjectWithEsmOnlyDep();
    const result = spawnSync(tsxBin, [entry], { cwd: root, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/No "exports" main defined|ERR_PACKAGE_PATH_NOT_EXPORTED/);
  });

  it('rejects when a dependency cannot be resolved (module-resolution errors are not swallowed)', async () => {
    const root = makeTmp();
    const entry = join(root, 'entry.ts');
    writeFileSync(entry, "import { nope } from 'definitely-not-installed-pkg';\nexport const value = nope;\n");
    await expect(importTsAsEsm(entry)).rejects.toThrow(/definitely-not-installed-pkg/);
  });
});

describe('provision-service-bootstrap.mjs CLI', () => {
  it('is a plain ES module entrypoint, not tsx-run TypeScript', () => {
    expect(existsSync(join(repoRoot, 'scripts', 'provision-service-bootstrap.ts'))).toBe(false);
    expect(readFileSync(entrypoint, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it.each([
    [[], /Pass exactly one of --all or <service>/],
    [['--all', 'market'], /Pass exactly one of --all or <service>/],
    [['--all', '--env', 'staging'], /--env must be 'dev' or 'prod'/],
    [['--all', '--bogus'], /Unexpected argument '--bogus'/],
  ])('rejects bad arguments %j with a non-zero exit', (args, message) => {
    const result = runEntrypoint(args);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(message);
  });
});

// The real entrypoint needs the workspace packages built (the deploy builds
// them first). The CI "Provisioning entrypoint" job always runs this against a
// production-style install; locally this runs once `pnpm -r --filter './packages/**' build` has.
const packagesBuilt = existsSync(join(repoRoot, 'packages', 'auth', 'dist', 'index.js'));

describe.skipIf(!packagesBuilt)('provision-service-bootstrap.mjs --dry-run (built workspace)', () => {
  it('loads every module a real run imports and exits 0, touching nothing', () => {
    const result = runEntrypoint(['--all', '--dry-run']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/kernel modules load as ESM — nothing changed/);
  });

  it('a single-service dry run prints no identity or key material', () => {
    const result = runEntrypoint(['market', '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/PRIVATE_KEY|did:imajin:/);
  });
});

describe('workflow wiring (#2483)', () => {
  const workflow = (name) => readFileSync(join(repoRoot, '.github', 'workflows', name), 'utf8');
  const stepRun = (file, stepName) => {
    const doc = parseYaml(workflow(file));
    const steps = Object.values(doc.jobs).flatMap((job) => job.steps ?? []);
    return steps.find((step) => step.name === stepName)?.run;
  };
  const PROVISION = 'Provision service bootstrap identities';

  it('deploy-prod and deploy-dev run the .mjs entrypoint under plain node', () => {
    expect(stepRun('deploy-prod.yml', PROVISION)).toBe(
      'node --env-file=apps/kernel/.env.local scripts/provision-service-bootstrap.mjs --all --env prod',
    );
    expect(stepRun('deploy-dev.yml', PROVISION)).toBe(
      'node --env-file=apps/kernel/.env.local scripts/provision-service-bootstrap.mjs --all --env dev',
    );
  });

  it('CI runs the deploy command verbatim, plus --dry-run', () => {
    const ci = stepRun('ci.yml', 'Dry-run the provisioning entrypoint (exact deploy command)');
    expect(ci).toBe(`${stepRun('deploy-prod.yml', PROVISION)} --dry-run`);
  });

  it('keeps #2478 ordering: build packages, provision, then build changed apps', () => {
    const doc = parseYaml(workflow('deploy-prod.yml'));
    const names = Object.values(doc.jobs).flatMap((job) => (job.steps ?? []).map((step) => step.name));
    const order = [
      'Install dependencies',
      'Build workspace packages (provisioning prerequisite)',
      PROVISION,
      'Build changed apps',
      'Run migrations',
    ].map((name) => names.indexOf(name));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order).not.toContain(-1);
  });
});
