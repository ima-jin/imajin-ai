import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('../ci-guard-no-swallowed-assertions.mjs', import.meta.url).pathname;

function makeTempRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'swallow-guard-'));
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  return dir;
}

function writeWorkflow(dir, name, content) {
  writeFileSync(join(dir, '.github', 'workflows', name), content, 'utf8');
}

async function runGuard(dir) {
  const { execFileSync } = await import('node:child_process');
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      cwd: dir,
      env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules'), CI_GUARD_WORKDIR: dir },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    return {
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
      status: e.status ?? 1,
    };
  }
}

describe('ci-guard-no-swallowed-assertions', () => {
  it('passes on clean workflows with no swallowed assertions', async () => {
    const dir = makeTempRepo();
    writeWorkflow(
      dir,
      'ci.yml',
      `name: CI
jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - name: Run tests
        run: pnpm test
`,
    );

    const result = await runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('fails on || true in an assertion step', async () => {
    const dir = makeTempRepo();
    writeWorkflow(
      dir,
      'ci.yml',
      `name: CI
jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - name: Run tests
        run: pnpm test || true
`,
    );

    const result = await runGuard(dir);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('FAIL');
    expect(result.stdout + result.stderr).toContain('|| true');
  });

  it('fails on continue-on-error: true in an assertion step', async () => {
    const dir = makeTempRepo();
    writeWorkflow(
      dir,
      'ci.yml',
      `name: CI
jobs:
  lint:
    name: Lint
    runs-on: ubuntu-latest
    steps:
      - name: Lint
        run: pnpm lint
        continue-on-error: true
`,
    );

    const result = await runGuard(dir);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('FAIL');
    expect(result.stdout + result.stderr).toContain('continue-on-error: true');
  });

  it('allows an exempted line with # ci-guard: allow', async () => {
    const dir = makeTempRepo();
    writeWorkflow(
      dir,
      'ci.yml',
      `name: CI
jobs:
  audit:
    name: Security Audit
    runs-on: ubuntu-latest
    steps:
      - name: Audit dependencies
        run: |
          pnpm audit --json > report.json || true # ci-guard: allow audit report consumed by gate below
          node scripts/audit-gate.mjs report.json
`,
    );

    const result = await runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('does not flag non-assertion steps', async () => {
    const dir = makeTempRepo();
    writeWorkflow(
      dir,
      'ci.yml',
      `name: CI
jobs:
  setup:
    name: Setup
    runs-on: ubuntu-latest
    steps:
      - name: Install dependencies
        run: pnpm install || true
`,
    );

    const result = await runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('does not flag scheduled security-audit workflow', async () => {
    const dir = makeTempRepo();
    writeWorkflow(
      dir,
      'security-audit.yml',
      `name: Scheduled Security Audit
on:
  schedule:
    - cron: '0 6 * * 1'
jobs:
  audit:
    name: Scheduled Audit
    runs-on: ubuntu-latest
    steps:
      - name: Run audit
        run: |
          pnpm audit --json > report.json || true # ci-guard: allow scheduled report workflow, not a gate
          node scripts/audit-gate.mjs report.json --report
`,
    );

    const result = await runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });
});
