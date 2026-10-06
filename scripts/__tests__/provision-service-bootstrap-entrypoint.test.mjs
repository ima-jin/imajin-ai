import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

// #2483: scripts/provision-service-bootstrap.mjs must run as ESM. The deploy
// step used to run a .ts entrypoint through `tsx`, which compiles it (and the
// kernel sources it imports) to CommonJS, so every ESM-only transitive
// dependency (@ipld/dag-cbor) failed with `No "exports" main defined`.
// #2485: the TypeScript is compiled to a native ES module at package build
// time (packages/provision-bootstrap); nothing is bundled at deploy time.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entrypoint = join(repoRoot, 'scripts', 'provision-service-bootstrap.mjs');
const builtLib = join(repoRoot, 'packages', 'provision-bootstrap', 'dist', 'index.mjs');

function runEntrypoint(args, { cwd = repoRoot, env = {} } = {}) {
  return spawnSync(process.execPath, [entrypoint, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'production', ...env },
  });
}

describe('provision-service-bootstrap.mjs CLI', () => {
  it('is a plain ES module entrypoint, not tsx-run TypeScript', () => {
    expect(existsSync(join(repoRoot, 'scripts', 'provision-service-bootstrap.ts'))).toBe(false);
    expect(readFileSync(entrypoint, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('has no runtime bundler in the deploy path (#2485)', () => {
    expect(existsSync(join(repoRoot, 'scripts', 'lib', 'import-ts-as-esm.mjs'))).toBe(false);
    const source = readFileSync(entrypoint, 'utf8');
    expect(source).not.toMatch(/esbuild|import-ts-as-esm|importTsAsEsm/);
    const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(rootManifest.devDependencies).not.toHaveProperty('esbuild');
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
const packagesBuilt = existsSync(builtLib) && existsSync(join(repoRoot, 'packages', 'auth', 'dist', 'index.js'));

describe.skipIf(!packagesBuilt)('pre-built provisioning module (#2485)', () => {
  it('is a self-contained native ES module that needs no runtime bundling', () => {
    const source = readFileSync(builtLib, 'utf8');
    expect(source).not.toMatch(/__require\(|Dynamic require/);
    // Repo-local kernel TypeScript is inlined; dependencies stay external imports.
    expect(source).not.toMatch(/from ['"]@\//);
    expect(source).toMatch(/from ['"]drizzle-orm/);
  });
});

describe('provision-service-bootstrap.mjs without the package build', () => {
  it('exits non-zero with a build hint when the pre-built module is missing', () => {
    // The entrypoint locates the repo from its own path: a copy in a bare tree has no build.
    const root = mkdtempSync(join(tmpdir(), 'provision-nobuild-'));
    try {
      mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
      copyFileSync(entrypoint, join(root, 'scripts', 'provision-service-bootstrap.mjs'));
      // The entrypoint statically imports the VAULT_PATH helper (#2487).
      copyFileSync(
        join(repoRoot, 'scripts', 'lib', 'vault-path-sources.mjs'),
        join(root, 'scripts', 'lib', 'vault-path-sources.mjs'),
      );
      const result = spawnSync(process.execPath, [join(root, 'scripts', 'provision-service-bootstrap.mjs'), '--all', '--dry-run'], {
        cwd: root,
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/packages\/provision-bootstrap\/dist\/index\.mjs is missing — run `pnpm -r --filter '\.\/packages\/\*\*' build` first/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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
