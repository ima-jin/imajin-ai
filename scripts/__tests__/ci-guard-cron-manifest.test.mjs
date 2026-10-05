import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// fileURLToPath, not `.pathname`: see ci-guard-stripe-import-scope.test.mjs.
const SCRIPT = fileURLToPath(new URL('../ci-guard-cron-manifest.mjs', import.meta.url));
const REAL_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function runGuard(workdir) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, CI_GUARD_WORKDIR: workdir },
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    return { stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '', status: e.status ?? 1 };
  }
}

function writeFile(dir, relPath, content) {
  const full = join(dir, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content, 'utf8');
}

function manifest(paths) {
  const jobs = paths.map((p) => `    { path: '${p}', schedule: '0 * * * *', noOverlap: true },`).join('\n');
  return `export const M = {\n  app: 'x',\n  jobs: [\n${jobs}\n  ],\n};\n`;
}

/** Builds a throwaway repo with one app `kernel`, the given routes and manifest paths. */
function makeRepo({ routes = [], paths = null, app = 'kernel' }) {
  const dir = mkdtempSync(join(tmpdir(), 'cron-manifest-guard-'));
  mkdirSync(join(dir, 'apps', app), { recursive: true });
  for (const name of routes) {
    writeFile(dir, `apps/${app}/app/api/cron/${name}/route.ts`, 'export async function GET() {}\n');
  }
  if (paths !== null) writeFile(dir, `apps/${app}/src/cron/schedule.ts`, manifest(paths));
  return dir;
}

describe('ci-guard-cron-manifest (#2550)', () => {
  it('passes against the real repository (manifest and routes agree)', () => {
    const result = runGuard(REAL_ROOT);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('passes when every route has an entry and every entry has a route', () => {
    const dir = makeRepo({ routes: ['a', 'b'], paths: ['/api/cron/a', '/api/cron/b'] });
    const result = runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('PASS');
  });

  it('fails when a route has no manifest entry', () => {
    const dir = makeRepo({ routes: ['a', 'orphan'], paths: ['/api/cron/a'] });
    const result = runGuard(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAIL');
    expect(result.stderr).toContain('app/api/cron/orphan/route.ts has no manifest entry');
  });

  it('fails when a manifest entry has no route', () => {
    const dir = makeRepo({ routes: ['a'], paths: ['/api/cron/a', '/api/cron/ghost'] });
    const result = runGuard(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("manifest entry '/api/cron/ghost' has no route");
  });

  it('fails when an app has cron routes but no manifest file', () => {
    const dir = makeRepo({ routes: ['a'], paths: null });
    const result = runGuard(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/cron/schedule.ts does not');
  });

  it('fails on malformed and duplicate manifest paths', () => {
    const dir = makeRepo({ routes: ['a'], paths: ['/api/cron/a', '/api/cron/a', '/api/other/a', '/api/cron/', '/api/cron/a/b'] });
    const result = runGuard(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lists '/api/cron/a' more than once");
    expect(result.stderr).toContain("manifest path '/api/other/a' must look like");
    expect(result.stderr).toContain("manifest path '/api/cron/' must look like");
    expect(result.stderr).toContain("manifest path '/api/cron/a/b' must look like");
  });

  it('ignores a cron directory with no route.ts and apps with neither routes nor a manifest', () => {
    const dir = makeRepo({ routes: ['a'], paths: ['/api/cron/a'] });
    mkdirSync(join(dir, 'apps', 'kernel', 'app', 'api', 'cron', 'not-a-route'), { recursive: true });
    mkdirSync(join(dir, 'apps', 'events'), { recursive: true });
    const result = runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('1 app(s) checked');
  });

  it('is per-app: a second app with its own manifest is checked independently', () => {
    const dir = makeRepo({ routes: ['a'], paths: ['/api/cron/a'] });
    writeFile(dir, 'apps/events/app/api/cron/sweep/route.ts', 'export async function GET() {}\n');
    writeFile(dir, 'apps/events/src/cron/schedule.ts', manifest(['/api/cron/sweep']));
    const ok = runGuard(dir);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('2 app(s) checked');

    writeFile(dir, 'apps/events/app/api/cron/other/route.ts', 'export async function GET() {}\n');
    const bad = runGuard(dir);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('apps/events: route app/api/cron/other/route.ts has no manifest entry');
  });

  it('passes trivially when there is no apps directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cron-manifest-guard-empty-'));
    const result = runGuard(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('0 app(s) checked');
  });
});
