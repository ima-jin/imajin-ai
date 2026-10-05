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
