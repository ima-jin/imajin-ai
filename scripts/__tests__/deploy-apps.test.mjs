import { afterEach, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('standalone events API specification ownership (#2517)', () => {
  it('does not recreate apps/events when generating monorepo specs', () => {
    const root = fixture();
    rmSync(join(root, 'apps/events'), { recursive: true });
    copyFileSync(join(ROOT, 'scripts/generate-api-specs.ts'), join(root, 'scripts/generate-api-specs.ts'));
    const output = execFileSync('pnpm', ['exec', 'tsx', join(root, 'scripts/generate-api-specs.ts')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(output).toContain('Done.');
    expect(output).not.toContain('✓ events:');
    expect(existsSync(join(root, 'apps/events'))).toBe(false);
  });
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
    it(`${env} selects declared monorepo apps after ownership release`, () => {
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
    const output = run(root, ['--deploy-env', 'dev', '--dry-run'], {
      GRAPH_CHANGES: '/home/jin/prod/imajin-ai/apps/events\n/home/jin/prod/imajin-ai/apps/kernel',
      PATH_CHANGES: 'apps/events/app/page.tsx',
    });
    expect(output).toContain('--dev --migration-owner=kernel kernel');
    expect(output).not.toMatch(/events/);
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
    for (const app of ['kernel', 'corpus']) {
      mkdirSync(join(root, `apps/${app}/.next`));
      writeFileSync(join(root, `apps/${app}/.next/BUILD_ID`), 'built');
    }
    expect(run(root, ['--deploy-env', 'dev', '--dry-run'])).toContain('Already built');
  });

  it('same-SHA stale owned app still builds even with an empty git diff', () => {
    const root = fixture();
    writeFileSync(join(root, '.last-build-sha'), 'current');
    expect(run(root, ['--deploy-env', 'dev', '--dry-run']))
      .toContain('--dev --migration-owner=kernel corpus kernel');
  });

  it('keeps non-deploy discovery unchanged', () => {
    expect(run(fixture(), ['--dry-run'])).toContain('corpus events kernel');
  });

  it('skips deleted apps in historical path and dependency graph changes outside deploy mode', () => {
    const root = fixture();
    rmSync(join(root, 'apps/events'), { recursive: true });
    writeFileSync(join(root, '.last-build-sha'), 'previous');
    const output = run(root, ['--dry-run'], {
      GRAPH_CHANGES: '/home/jin/prod/imajin-ai/apps/events',
      PATH_CHANGES: 'apps/events/app/page.tsx\napps/kernel/app/page.tsx',
    });
    expect(output).toContain('1 app(s) to build: kernel');
    expect(output).not.toContain('events');
  });

  it('does not invoke build.sh for an incremental prune-only diff', () => {
    const root = fixture();
    // Rollback files may remain on disk, but they are not a workspace app.
    rmSync(join(root, 'apps/events/package.json'));
    writeFileSync(join(root, '.last-build-sha'), 'previous');
    expect(run(root, [], {
      PATH_CHANGES: 'apps/events/package.json',
    })).toContain('No apps changed');
    expect(existsSync(join(root, 'build-args'))).toBe(false);
    expect(readFileSync(join(root, '.last-build-sha'), 'utf8').trim()).toBe('current');
  });

  it('also excludes deleted ecosystem-owned apps from historical diffs', () => {
    const root = fixture();
    rmSync(join(root, 'apps/corpus'), { recursive: true });
    writeFileSync(join(root, '.last-build-sha'), 'previous');
    expect(run(root, ['--deploy-env', 'dev', '--dry-run'], {
      PATH_CHANGES: 'apps/corpus/package.json',
    })).toContain('No apps changed');
  });
  it('prod-window release bounds full builds and scopes migrations to kernel', () => {
    const root = fixture();
    run(root, ['--deploy-env', 'prod']);
    expect(readFileSync(join(root, 'build-args'), 'utf8').trim().split('\n'))
      .toEqual(['--prod', '--migration-owner=kernel', 'kernel']);
  });

  it('prod-window release no longer builds events-only incremental changes', () => {
    const root = fixture();
    writeFileSync(join(root, '.last-build-sha'), 'previous');
    expect(run(root, ['--deploy-env', 'prod', '--dry-run'], {
      PATH_CHANGES: 'apps/events/app/page.tsx',
    })).toContain('No apps changed');
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
    it(`${env} scopes builds and migrations after its ownership release`, () => {
      const workflow = parse(readFileSync(join(ROOT, `.github/workflows/deploy-${env}.yml`), 'utf8'));
      const steps = workflow.jobs.deploy.steps;
      expect(steps.find((step) => step.name === 'Build changed apps').run)
        .toBe(`./scripts/build-changed.sh --deploy-env ${env}`);
      expect(steps.find((step) => step.name === 'Run migrations').run)
        .toBe('node scripts/migrate.mjs --owner kernel');
    });
  }

  it.each([
    { env: 'dev', flags: ['--migration-owner=kernel'], expected: ['--owner', 'kernel'] },
    { env: 'prod', flags: ['--migration-owner=kernel'], expected: ['--owner', 'kernel'] },
    { env: 'prod', flags: [], expected: [] },
  ])('real build.sh forwards $env migration args $expected', ({ env, flags, expected }) => {
    const root = fixture();
    copyFileSync(join(ROOT, 'scripts/build.sh'), join(root, 'scripts/build.sh'));
    // Stop at migration invocation, before metadata/build/restart. The failure
    // is intentional and verifies the real command without any DB or pm2 use.
    writeFileSync(join(root, 'bin/node'), `#!/bin/bash
printf '%s\\n' "$@" > migration-args
exit 1
`, { mode: 0o755 });
    expect(() => execFileSync('/bin/bash', ['scripts/build.sh', `--${env}`, ...flags, 'kernel'], {
      cwd: root,
      env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}` },
      stdio: 'pipe',
    })).toThrow();
    expect(readFileSync(join(root, 'migration-args'), 'utf8').trim().split('\n'))
      .toEqual(['scripts/migrate.mjs', ...expected]);
  });
});
