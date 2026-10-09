import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    [[], /Pass exactly one of --all, <service>, --service-dir <path> or --app <slug>/],
    [['--all', 'market'], /Pass exactly one of --all, <service>, --service-dir <path> or --app <slug>/],
    [['--app', 'links', '--service-dir', '/tmp/links'], /Pass exactly one of --all, <service>, --service-dir <path> or --app <slug>/],
    [['--app', 'links', 'market'], /Pass exactly one of --all, <service>, --service-dir <path> or --app <slug>/],
    [['--all', '--env', 'staging'], /--env must be 'dev' or 'prod'/],
    [['--all', '--bogus'], /Unexpected argument '--bogus'/],
    [['--app'], /--app needs a value/],
    [['--service-dir', '--dry-run'], /--service-dir needs a value/],
    [['--app', '../links'], /--app takes a slug like 'links'/],
    [['--app', 'Links/../x'], /--app takes a slug like 'links'/],
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
    const result = runEntrypoint(['events', '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).not.toMatch(/PRIVATE_KEY|did:imajin:/);
  });
});

// #2712: a standalone app's checkout is provisioned through the same entrypoint.
describe.skipIf(!packagesBuilt)('provision-service-bootstrap.mjs --service-dir (built workspace)', () => {
  const tmpDirs = [];
  const makeCheckout = (name, { example, envLocal } = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'provision-external-'));
    tmpDirs.push(root);
    const dir = join(root, name);
    mkdirSync(dir);
    writeFileSync(join(dir, '.env.example'), example ?? `${name.toUpperCase()}_VAULT_BOOTSTRAP_DID=\n${name.toUpperCase()}_VAULT_BOOTSTRAP_PRIVATE_KEY=\n`);
    if (envLocal !== undefined) writeFileSync(join(dir, '.env.local'), envLocal);
    return dir;
  };
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('dry-runs a checkout without writing anything or printing key material', () => {
    const dir = makeCheckout('links', { envLocal: 'PORT=3102\n' });
    const result = runEntrypoint(['--service-dir', dir, '--dry-run']);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/links · dry-run · would mint/);
    expect(result.stdout).not.toMatch(/PRIVATE_KEY|did:imajin:/);
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe('PORT=3102\n');
  });

  it('resolves --app <slug> next to the kernel checkout', () => {
    const result = runEntrypoint(['--app', 'no-such-app-2712', '--dry-run']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`no-such-app-2712: ${join(dirname(repoRoot), 'no-such-app-2712')} has no .env.example`);
  });

  it('exits non-zero when the checkout has no .env.example', () => {
    const dir = makeCheckout('links');
    rmSync(join(dir, '.env.example'));
    const result = runEntrypoint(['--service-dir', dir, '--dry-run']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/has no \.env\.example/);
  });

  it('exits non-zero when the checkout declares no bootstrap DID', () => {
    const dir = makeCheckout('links', { example: 'PORT=\n' });
    const result = runEntrypoint(['--service-dir', dir, '--dry-run']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/declares no required <SVC>_VAULT_BOOTSTRAP_DID/);
  });

  it('exits non-zero, naming the file, when the checkout has no .env.local', () => {
    const dir = makeCheckout('links');
    const result = runEntrypoint(['--service-dir', dir, '--dry-run']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not exist — create it first/);
    expect(existsSync(join(dir, '.env.local'))).toBe(false);
  });

  it('exits non-zero on a half-written pair without echoing the key or touching the file', () => {
    const content = 'LINKS_VAULT_BOOTSTRAP_PRIVATE_KEY=half-secret-value\n';
    const dir = makeCheckout('links', { envLocal: content });
    const result = runEntrypoint(['--service-dir', dir, '--dry-run']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must define both LINKS_VAULT_BOOTSTRAP_DID and LINKS_VAULT_BOOTSTRAP_PRIVATE_KEY/);
    expect(result.stdout + result.stderr).not.toContain('half-secret-value');
    expect(readFileSync(join(dir, '.env.local'), 'utf8')).toBe(content);
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
