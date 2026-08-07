/**
 * Tests for the required-context producer guard (#1559).
 *
 * The previous version of this suite asserted only that the guard exited 0 or
 * printed "SKIP|FAIL", and deferred to "the real behaviour is validated in CI
 * against the real repo". It was not: in CI the guard hit its skip branch on
 * every run and asserted nothing. These tests therefore pin the OUTCOME —
 * which inputs must fail the process — rather than the log text.
 *
 * Every case runs with no GitHub token in the environment, so the live-ruleset
 * drift check degrades and only the offline producer checks are under test.
 * That is deliberate: the offline half is the part that has to work unaided.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not `.pathname`: on Windows the latter yields "/D:/...", which
// node then resolves against the cwd into "C:\D:\..." and cannot load.
const SCRIPT = fileURLToPath(new URL('../ci-guard-required-contexts.mjs', import.meta.url));

const WORKFLOW = `name: CI
jobs:
  lint:
    name: Lint & Typecheck
    runs-on: ubuntu-latest
  test:
    name: Test
    runs-on: ubuntu-latest
  audit:
    name: Security Audit
    runs-on: ubuntu-latest
`;

function makeRepo({ workflow = WORKFLOW, manifest }) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-guard-'));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), workflow, 'utf8');
  if (manifest !== undefined) {
    writeFileSync(join(dir, '.github', 'required-checks.json'), JSON.stringify(manifest), 'utf8');
  }
  return dir;
}

function runGuard(dir) {
  // Strip both tokens so the drift check always degrades: these tests cover the
  // offline half, and a developer's ambient token must not change the outcome.
  const env = { ...process.env, CI_GUARD_WORKDIR: dir };
  delete env.GITHUB_TOKEN;
  delete env.RULESET_READ_TOKEN;
  delete env.CI_GUARD_REQUIRE_RULESET;

  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: dir, env });
    return { status: 0, output: stdout };
  } catch (e) {
    return {
      status: e.status ?? 1,
      output: (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? ''),
    };
  }
}

describe('ci-guard-required-contexts', () => {
  it('passes when every required context has a producing job', () => {
    const dir = makeRepo({
      manifest: { required: ['Lint & Typecheck', 'Test'], advisory: [] },
    });

    const { status } = runGuard(dir);

    expect(status).toBe(0);
  });

  /**
   * The #1561 regression: the ruleset required `Lint & Typecheck` while the job
   * had been renamed to `Lint`, so the context waited forever and the check
   * quietly stopped gating. This is the case the guard exists for, and the case
   * it could never actually catch while it skipped.
   */
  it('fails when a required context has no producing job', () => {
    const dir = makeRepo({
      workflow: `name: CI
jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
`,
      manifest: { required: ['Lint & Typecheck'], advisory: [] },
    });

    const { status, output } = runGuard(dir);

    expect(status).toBe(1);
    expect(output).toContain('Lint & Typecheck');
  });

  it('fails on an advisory entry whose job no longer exists', () => {
    const dir = makeRepo({
      manifest: {
        required: ['Test'],
        advisory: [{ context: 'Deleted Job', reason: 'stale' }],
      },
    });

    const { status, output } = runGuard(dir);

    expect(status).toBe(1);
    expect(output).toContain('Deleted Job');
  });

  it('fails when a context is both required and advisory', () => {
    const dir = makeRepo({
      manifest: {
        required: ['Test'],
        advisory: [{ context: 'Test', reason: 'contradictory' }],
      },
    });

    const { status, output } = runGuard(dir);

    expect(status).toBe(1);
    expect(output).toContain('BOTH required and advisory');
  });

  it('fails on duplicate required entries', () => {
    const dir = makeRepo({ manifest: { required: ['Test', 'Test'], advisory: [] } });

    const { status, output } = runGuard(dir);

    expect(status).toBe(1);
    expect(output).toContain('duplicate');
  });

  it('fails when the manifest is missing rather than passing vacuously', () => {
    const dir = makeRepo({ manifest: undefined });

    const { status, output } = runGuard(dir);

    expect(status).toBe(1);
    expect(output).toContain('required-checks.json');
  });

  it('fails when the manifest declares no required contexts', () => {
    const dir = makeRepo({ manifest: { required: [], advisory: [] } });

    const { status } = runGuard(dir);

    expect(status).toBe(1);
  });

  /**
   * Degrading is allowed; degrading silently is not. Without a token the guard
   * still completes its offline checks, but must say out loud that drift was
   * not verified.
   */
  it('warns visibly when the live ruleset cannot be read', () => {
    const dir = makeRepo({ manifest: { required: ['Test'], advisory: [] } });

    const { status, output } = runGuard(dir);

    expect(status).toBe(0);
    expect(output).toContain('::warning::');
    expect(output).toContain('NOT verified');
  });

  it('treats an unreadable ruleset as fatal under CI_GUARD_REQUIRE_RULESET=1', () => {
    const dir = makeRepo({ manifest: { required: ['Test'], advisory: [] } });
    const env = { ...process.env, CI_GUARD_WORKDIR: dir, CI_GUARD_REQUIRE_RULESET: '1' };
    delete env.GITHUB_TOKEN;
    delete env.RULESET_READ_TOKEN;

    let status = 0;
    try {
      execFileSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: dir, env });
    } catch (e) {
      status = e.status ?? 1;
    }

    expect(status).toBe(1);
  });
});
