#!/usr/bin/env node
/**
 * Cron manifest drift guard (#2550).
 *
 * ## Why this exists
 *
 * Scheduled jobs are declared in exactly one place per app:
 * `apps/<app>/src/cron/schedule.ts` (the kernel's lives at
 * `apps/kernel/src/cron/schedule.ts`), which the `*-kernel-cron` pm2 scheduler
 * reads. Before #2550 the schedules lived in `apps/kernel/vercel.json`, which
 * we never deploy through — so every job silently never ran. A cron route
 * with no manifest entry is a job that never fires; a manifest entry with no
 * route is a scheduler that 404s forever. Both are silent in production, so
 * this guard turns the drift into a CI failure.
 *
 * ## What it checks
 *
 * For every app under `apps/`:
 *   1. every `app/api/cron/<name>/route.ts` has a manifest entry whose path is
 *      `/api/cron/<name>`;
 *   2. every manifest entry's path is `/api/cron/<name>` and has a route;
 *   3. an app that has cron routes but no `src/cron/schedule.ts` fails.
 *
 * The manifest is read as TEXT (`path: '/api/cron/...'` literals), never
 * imported, so the guard needs no TypeScript toolchain and no build. Keep
 * manifest entries as plain object literals (see schedule.ts).
 *
 * ## Sonar-clean notes
 *
 * - No process spawning (S4036); only reads files.
 * - No regex with nested quantifiers: a single flat pattern per literal.
 *
 * ## Usage
 *
 * `node scripts/ci-guard-cron-manifest.mjs`
 *
 * Env overrides (for tests):
 *   - `CI_GUARD_WORKDIR` — repo root (default: one level up from this file)
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.CI_GUARD_WORKDIR
  ? resolve(process.env.CI_GUARD_WORKDIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ROUTE_PREFIX = '/api/cron/';
const PATH_LITERAL_RE = /\bpath:\s*'([^']*)'/g;

/** Names of `apps/<app>/app/api/cron/<name>/route.ts` directories for one app. */
function listRouteNames(appDir) {
  const cronDir = join(appDir, 'app', 'api', 'cron');
  if (!existsSync(cronDir)) return [];
  return readdirSync(cronDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(cronDir, entry.name, 'route.ts')))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/** Every `path: '...'` literal in the manifest file, in source order. */
function readManifestPaths(manifestFile) {
  const text = readFileSync(manifestFile, 'utf8');
  return Array.from(text.matchAll(PATH_LITERAL_RE), (match) => match[1]);
}

function checkApp(app, appDir) {
  const problems = [];
  const routes = listRouteNames(appDir);
  const manifestFile = join(appDir, 'src', 'cron', 'schedule.ts');

  if (!existsSync(manifestFile)) {
    for (const name of routes) {
      problems.push(`apps/${app}: route app/api/cron/${name}/route.ts exists but apps/${app}/src/cron/schedule.ts does not`);
    }
    return problems;
  }

  const entryNames = new Set();
  for (const path of readManifestPaths(manifestFile)) {
    if (!path.startsWith(ROUTE_PREFIX) || path.length === ROUTE_PREFIX.length || path.includes('/', ROUTE_PREFIX.length)) {
      problems.push(`apps/${app}: manifest path '${path}' must look like ${ROUTE_PREFIX}<name>`);
      continue;
    }
    const name = path.slice(ROUTE_PREFIX.length);
    if (entryNames.has(name)) problems.push(`apps/${app}: manifest lists '${path}' more than once`);
    entryNames.add(name);
  }

  for (const name of routes) {
    if (!entryNames.has(name)) {
      problems.push(`apps/${app}: route app/api/cron/${name}/route.ts has no manifest entry (it would never run)`);
    }
  }
  const routeSet = new Set(routes);
  for (const name of entryNames) {
    if (!routeSet.has(name)) {
      problems.push(`apps/${app}: manifest entry '${ROUTE_PREFIX}${name}' has no route (app/api/cron/${name}/route.ts)`);
    }
  }
  return problems;
}

function scanRepo() {
  const appsDir = join(ROOT, 'apps');
  if (!existsSync(appsDir)) return { problems: [], checked: 0 };
  const apps = readdirSync(appsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const problems = [];
  let checked = 0;
  for (const app of apps) {
    const appDir = join(appsDir, app);
    const hasManifest = existsSync(join(appDir, 'src', 'cron', 'schedule.ts'));
    if (!hasManifest && listRouteNames(appDir).length === 0) continue;
    checked += 1;
    problems.push(...checkApp(app, appDir));
  }
  return { problems, checked };
}

function main() {
  let result;
  try {
    result = scanRepo();
  } catch (err) {
    console.error(`ci-guard-cron-manifest: ${err.message}`);
    process.exit(1);
    return;
  }

  if (result.problems.length > 0) {
    console.error(`\nFAIL: cron manifest and cron routes have drifted (${result.problems.length} problem(s)):\n`);
    for (const problem of result.problems) console.error(`  - ${problem}`);
    console.error(
      '\nEvery apps/<app>/app/api/cron/<name>/route.ts needs a { path: \'/api/cron/<name>\', ... } entry in ' +
        'apps/<app>/src/cron/schedule.ts, and every entry needs its route. See #2550.',
    );
    process.exit(1);
    return;
  }

  console.log(`PASS: cron manifest and cron routes agree (${result.checked} app(s) checked).`);
  process.exit(0);
}

main();
