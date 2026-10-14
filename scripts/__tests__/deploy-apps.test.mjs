import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import { deployApps } from '../lib/deploy-apps.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const require = createRequire(import.meta.url);
const fixtures = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'deploy-ownership-'));
  fixtures.push(root);
  for (const dir of ['scripts/lib', 'deploy', 'bin', 'apps/kernel', 'apps/events', 'apps/corpus']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  for (const file of [
    'scripts/build-changed.sh', 'scripts/lib/deploy-apps.mjs',
    'deploy/ecosystem.dev.config.js', 'deploy/ecosystem.prod.config.js',
  ]) copyFileSync(join(ROOT, file), join(root, file));
  for (const app of ['kernel', 'events', 'corpus']) {
    writeFileSync(join(root, 'apps', app, 'package.json'), '{}');
  }
  // Deterministic command doubles: no git identity, database, env files or pm2.
  writeFileSync(join(root, 'bin/git'), `#!/bin/bash
case "$*" in
  "rev-parse --show-toplevel") printf '%s\\n' "$FIXTURE_ROOT" ;;
  "rev-parse HEAD") printf 'current\\n' ;;
  diff*) printf '%s\\n' "\${PATH_CHANGES:-}" ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(root, 'bin/pnpm'), `#!/bin/bash
printf '%s\\n' "\${GRAPH_CHANGES:-}"
`, { mode: 0o755 });
  writeFileSync(join(root, 'scripts/build.sh'), `#!/bin/bash
printf '%s\\n' "$@" > build-args
`, { mode: 0o755 });
  return root;
}

function run(root, args, env = {}) {
  return execFileSync('/bin/bash', ['scripts/build-changed.sh', ...args], {
    cwd: root,
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, FIXTURE_ROOT: root, ...env },
    encoding: 'utf8',
  });
}

describe('ecosystem is the positive deploy build boundary (#2784)', () => {
  for (const env of ['dev', 'prod']) {
    it(`${env} builds only declared monorepo apps, not events or external repos`, () => {
      const apps = deployApps(require(`../../deploy/ecosystem.${env}.config.js`));
      expect(apps).toContain('kernel');
      expect(apps).not.toContain('events');
      expect(apps).not.toContain('fixready');
      expect(apps.filter((app) => app === 'kernel')).toHaveLength(1);
      expect(apps.includes('corpus')).toBe(env === 'dev');
    });
  }

  it('fails closed without a kernel cwd anchor', () => {
    expect(() => deployApps({ apps: [] })).toThrow('kernel cwd');
    expect(() => deployApps({ apps: [{ name: 'dev-jin', cwd: '/wrong' }] })).toThrow('kernel cwd');
  });

  it('does not hardcode an events exclusion when ownership is explicitly declared', () => {
    expect(deployApps({ apps: [
      { name: 'dev-jin', cwd: '/repo/apps/kernel' },
      { name: 'dev-events', cwd: '/repo/apps/events' },
    ] })).toEqual(['kernel', 'events']);
  });

  it('full deploy build passes kernel migration ownership through to build.sh', () => {
    const root = fixture();
    run(root, ['--deploy-env', 'dev']);
    expect(readFileSync(join(root, 'build-args'), 'utf8').trim().split('\n'))
      .toEqual(['--dev', '--migration-owner=kernel', 'corpus', 'kernel']);
  });

  it('bounds graph and direct-path incremental changes by ecosystem ownership', () => {
    const root = fixture();
    writeFileSync(join(root, '.last-build-sha'), 'previous');
    const output = run(root, ['--deploy-env', 'prod', '--dry-run'], {
      GRAPH_CHANGES: '/home/jin/prod/imajin-ai/apps/events\n/home/jin/prod/imajin-ai/apps/kernel',
      PATH_CHANGES: 'apps/events/app/page.tsx\napps/corpus/src/index.ts',
    });
    expect(output).toContain('--prod --migration-owner=kernel kernel');
    expect(output).not.toMatch(/events|corpus/);
  });

  it('events-only changes never invoke build.sh or stamp a dry run', () => {
    const root = fixture();
    writeFileSync(join(root, '.last-build-sha'), 'previous');
    expect(run(root, ['--deploy-env', 'dev', '--dry-run'], {
      PATH_CHANGES: 'apps/events/app/page.tsx',
    })).toContain('No apps changed');
    expect(readFileSync(join(root, '.last-build-sha'), 'utf8')).toBe('previous');
  });

  it('same-SHA stale events does not trigger a deploy when owned apps are fresh', () => {
    const root = fixture();
    writeFileSync(join(root, '.last-build-sha'), 'current');
    mkdirSync(join(root, 'apps/kernel/.next'));
    writeFileSync(join(root, 'apps/kernel/.next/BUILD_ID'), 'built');
    expect(run(root, ['--deploy-env', 'prod', '--dry-run'])).toContain('Already built');
  });

  it('same-SHA stale owned app still builds even with an empty git diff', () => {
    const root = fixture();
    writeFileSync(join(root, '.last-build-sha'), 'current');
    expect(run(root, ['--deploy-env', 'prod', '--dry-run']))
      .toContain('--prod --migration-owner=kernel kernel');
  });

  it('keeps non-deploy discovery unchanged', () => {
    expect(run(fixture(), ['--dry-run'])).toContain('corpus events kernel');
  });

  it('rejects a missing or invalid deployment environment', () => {
    const root = fixture();
    for (const args of [['--deploy-env'], ['--deploy-env', 'staging'], ['--unknown']]) {
      expect(() => run(root, args)).toThrow();
    }
  });
});

describe('kernel deploy workflow ownership wiring', () => {
  for (const env of ['dev', 'prod']) {
    it(`${env} scopes both build selection and explicit migrations`, () => {
      const workflow = parse(readFileSync(join(ROOT, `.github/workflows/deploy-${env}.yml`), 'utf8'));
      const steps = workflow.jobs.deploy.steps;
      expect(steps.find((step) => step.name === 'Build changed apps').run)
        .toBe(`./scripts/build-changed.sh --deploy-env ${env}`);
      expect(steps.find((step) => step.name === 'Run migrations').run)
        .toBe('node scripts/migrate.mjs --owner kernel');
    });
  }

  it('build.sh forwards the selected owner to its migration call', () => {
    const build = readFileSync(join(ROOT, 'scripts/build.sh'), 'utf8');
    expect(build).toContain('--migration-owner=*) MIGRATION_FLAGS=("--owner" "${arg#*=}")');
    expect(build).toContain('node scripts/migrate.mjs "${MIGRATION_FLAGS[@]}"');
  });
});
