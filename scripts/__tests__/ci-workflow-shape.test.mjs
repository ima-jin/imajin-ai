/**
 * Shape guard for the CI workflows (#2601).
 *
 * Pins three properties that are easy to regress with a copy-pasted job:
 *
 *  1. No job on the self-hosted container runner restores/saves the pnpm store
 *     through setup-node's `cache: 'pnpm'` (a ~574 MB GitHub-cache round trip
 *     per job; it stalled at "Received 0 of 574215594" and held the only
 *     runner slot).
 *  2. Every such job that runs `pnpm install` mounts the runner host's
 *     persistent store dir and points pnpm's store-dir at the mount.
 *  3. ci.yml has workflow-level concurrency that cancels superseded
 *     pull_request runs and never cancels merge_group (or push/dispatch) runs,
 *     and it still triggers on merge_group.
 *
 * And, for the Turborepo local cache (#2605):
 *
 *  4. Every container job that runs turbo (directly, or through the root
 *     `build` / `lint` / `typecheck` scripts, which are wired through
 *     `turbo run`) mounts the runner host's turbo cache dir and points
 *     TURBO_CACHE_DIR at it.
 *  5. No workflow declares TURBO_TOKEN / TURBO_TEAM (local cache only, no
 *     Vercel remote cache).
 *  6. turbo.json exists with build and typecheck (and lint) pipelines that
 *     declare their dependsOn/outputs, keep `.next/cache` out of turbo's
 *     outputs, and never cache the coverage-producing test task.
 *  7. The root scripts really go through `turbo run`, and the Test job (the
 *     one that feeds SonarCloud) still runs plain `vitest` via `test:coverage`.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import YAML from 'yaml';

const WORKFLOWS_DIR = fileURLToPath(new URL('../../.github/workflows/', import.meta.url));

const HOST_STORE_DIR = '/srv/ci/pnpm-store';
const MOUNT_PATH = '/pnpm-store';

function loadWorkflow(file) {
  return YAML.parse(readFileSync(join(WORKFLOWS_DIR, file), 'utf8'));
}

function allWorkflows() {
  return readdirSync(WORKFLOWS_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .map((file) => ({ file, workflow: loadWorkflow(file) }));
}

/** Every job that runs on imajin-self-hosted inside a container. */
function containerJobs() {
  const out = [];
  for (const { file, workflow } of allWorkflows()) {
    for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
      const runsOn = [job['runs-on']].flat();
      if (runsOn.includes('imajin-self-hosted') && job.container) {
        out.push({ label: `${file}#${id}`, job });
      }
    }
  }
  return out;
}

function steps(job) {
  return job.steps ?? [];
}

function runsPnpmInstall(job) {
  return steps(job).some((s) => typeof s.run === 'string' && /\bpnpm install\b/.test(s.run));
}

describe('self-hosted container jobs (pnpm store, #2601)', () => {
  const jobs = containerJobs();

  it('finds the container jobs it is supposed to guard', () => {
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.filter(({ job }) => runsPnpmInstall(job)).length).toBeGreaterThan(0);
  });

  it.each(jobs.map((j) => [j.label, j.job]))(
    '%s does not use setup-node `cache: pnpm`',
    (_label, job) => {
      for (const step of steps(job)) {
        expect(step.with?.cache, `step "${step.name ?? step.uses}"`).not.toBe('pnpm');
      }
    },
  );

  const installers = jobs.filter(({ job }) => runsPnpmInstall(job));

  it.each(installers.map((j) => [j.label, j.job]))(
    '%s mounts the host pnpm store and points pnpm at it',
    (_label, job) => {
      expect(job.container.volumes).toContain(`${HOST_STORE_DIR}:${MOUNT_PATH}`);
      expect(job.env?.npm_config_store_dir).toBe(MOUNT_PATH);
    },
  );

  it.each(installers.map((j) => [j.label, j.job]))(
    '%s keeps the frozen-lockfile install',
    (_label, job) => {
      const installs = steps(job).filter(
        (s) => typeof s.run === 'string' && /\bpnpm install\b/.test(s.run),
      );
      for (const s of installs) {
        expect(s.run).toContain('--frozen-lockfile');
      }
    },
  );
});

// ── Turborepo local cache (#2605) ───────────────────────────────────────────

const HOST_TURBO_DIR = '/srv/ci/turbo-cache';
const TURBO_MOUNT_PATH = '/turbo-cache';
const ROOT_DIR = fileURLToPath(new URL('../../', import.meta.url));

const rootPackage = JSON.parse(readFileSync(join(ROOT_DIR, 'package.json'), 'utf8'));

/** Root scripts that are wired through `turbo run`. */
function turboRootScripts() {
  return Object.entries(rootPackage.scripts)
    .filter(([, cmd]) => /\bturbo run\b/.test(cmd))
    .map(([name]) => name);
}

/** True when a step invokes turbo, directly or via a turbo-wired root script. */
function runsTurbo(job) {
  const wired = turboRootScripts();
  return steps(job).some((s) => {
    if (typeof s.run !== 'string') return false;
    if (/\bturbo\b/.test(s.run)) return true;
    return wired.some((name) => new RegExp(`\\bpnpm (run )?${name}\\b`).test(s.run));
  });
}

/** turbo.json allows comments; strip whole-line `//` comments before parsing. */
function loadTurboJson() {
  const raw = readFileSync(join(ROOT_DIR, 'turbo.json'), 'utf8');
  return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
}

describe('turbo local cache on the self-hosted container jobs (#2605)', () => {
  const turboJobs = containerJobs().filter(({ job }) => runsTurbo(job));

  it('wires build, lint and typecheck through turbo run', () => {
    expect(turboRootScripts()).toEqual(expect.arrayContaining(['build', 'lint', 'typecheck']));
  });

  it('finds the jobs that run turbo (lint-and-typecheck and build)', () => {
    const labels = turboJobs.map((j) => j.label);
    expect(labels).toContain('ci.yml#lint-and-typecheck');
    expect(labels).toContain('ci.yml#build');
  });

  it.each(turboJobs.map((j) => [j.label, j.job]))(
    '%s mounts the host turbo cache and points turbo at it',
    (_label, job) => {
      expect(job.container.volumes).toContain(`${HOST_TURBO_DIR}:${TURBO_MOUNT_PATH}`);
      expect(job.env?.TURBO_CACHE_DIR).toBe(TURBO_MOUNT_PATH);
    },
  );

  it.each(turboJobs.map((j) => [j.label, j.job]))(
    '%s keeps the pnpm store mount alongside the turbo mount',
    (_label, job) => {
      expect(job.container.volumes).toContain(`${HOST_STORE_DIR}:${MOUNT_PATH}`);
    },
  );

  it('does not run the coverage-producing Test job through turbo (Sonar coverage stays complete)', () => {
    const test = loadWorkflow('ci.yml').jobs.test;
    expect(runsTurbo(test)).toBe(false);
    expect(steps(test).some((s) => s.run === 'pnpm test:coverage')).toBe(true);
    expect(rootPackage.scripts['test:coverage']).not.toMatch(/\bturbo\b/);
    expect(rootPackage.scripts.test).not.toMatch(/\bturbo\b/);
  });

  it('persists the per-app Next.js build cache around the Build step', () => {
    const names = steps(loadWorkflow('ci.yml').jobs.build).map((s) => s.name);
    const restore = names.indexOf('Restore Next.js build cache');
    const build = names.indexOf('Build');
    const save = names.indexOf('Save Next.js build cache');
    expect(restore).toBeGreaterThanOrEqual(0);
    expect(restore).toBeLessThan(build);
    expect(save).toBeGreaterThan(build);
  });
});

describe('no remote turbo cache (#2605)', () => {
  it.each(allWorkflows().map((w) => [w.file, w.workflow]))(
    '%s declares no TURBO_TOKEN / TURBO_TEAM',
    (file) => {
      const text = readFileSync(join(WORKFLOWS_DIR, file), 'utf8');
      expect(text).not.toMatch(/TURBO_TOKEN/);
      expect(text).not.toMatch(/TURBO_TEAM/);
    },
  );

  it('has no workflow-level env in ci.yml pointing turbo at a remote', () => {
    const ci = loadWorkflow('ci.yml');
    expect(Object.keys(ci.env ?? {}).filter((k) => k.startsWith('TURBO_'))).toEqual([]);
  });
});

describe('turbo.json pipelines (#2605)', () => {
  const turbo = loadTurboJson();

  it('exists with build, typecheck and lint pipelines', () => {
    expect(Object.keys(turbo.tasks)).toEqual(expect.arrayContaining(['build', 'typecheck', 'lint']));
  });

  it('makes build and typecheck wait for their dependencies\' builds', () => {
    expect(turbo.tasks.build.dependsOn).toContain('^build');
    expect(turbo.tasks.typecheck.dependsOn).toContain('^build');
  });

  it('caches build output, but never .next/cache', () => {
    const outputs = turbo.tasks.build.outputs;
    expect(outputs).toEqual(expect.arrayContaining(['dist/**', '.next/**', '!.next/cache/**']));
    expect(outputs).not.toContain('.next/cache/**');
  });

  it('declares explicit inputs for build and lint', () => {
    expect(turbo.tasks.build.inputs).toContain('$TURBO_DEFAULT$');
    expect(turbo.tasks.lint.inputs).toContain('$TURBO_DEFAULT$');
    expect(turbo.tasks.lint.inputs).toContain('$TURBO_ROOT$/eslint.config.mjs');
  });

  it('hashes the shared tsconfig into every task', () => {
    expect(turbo.globalDependencies).toContain('tsconfig.base.json');
  });

  it('never caches the coverage-producing test tasks', () => {
    expect(turbo.tasks['//#test'].cache).toBe(false);
    expect(turbo.tasks['//#test:coverage'].cache).toBe(false);
  });

  it('has no remote-cache configuration', () => {
    expect(turbo.remoteCache).toBeUndefined();
  });

  it('adds the kernel\'s repo-root docs to its build inputs', () => {
    const raw = readFileSync(join(ROOT_DIR, 'apps/kernel/turbo.json'), 'utf8');
    const kernel = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
    expect(kernel.extends).toEqual(['//']);
    expect(kernel.tasks.build.inputs).toEqual(
      expect.arrayContaining(['$TURBO_DEFAULT$', '$TURBO_ROOT$/docs/**']),
    );
  });

  it('declares turbo as a root devDependency', () => {
    expect(rootPackage.devDependencies.turbo).toBeDefined();
  });
});

describe('ci.yml concurrency (#2601)', () => {
  const ci = loadWorkflow('ci.yml');

  it('still triggers on merge_group', () => {
    expect(Object.keys(ci.on)).toContain('merge_group');
  });

  it('groups by PR number, falling back to the ref', () => {
    expect(ci.concurrency).toBeDefined();
    expect(ci.concurrency.group).toBe('ci-${{ github.event.pull_request.number || github.ref }}');
  });

  it('cancels superseded runs only for pull_request events', () => {
    expect(ci.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });
});
