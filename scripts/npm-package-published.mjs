#!/usr/bin/env node
/**
 * Reports whether a prepared package's exact name@version is already on a
 * registry (#2578).
 *
 * ## Why this exists
 *
 * publish-packages.yml now runs automatically on every `vX.Y.Z` release tag
 * (tag-release.yml), and a failed run is re-run by hand. `npm publish` of a
 * version that already exists is a hard error (409 / EPUBLISHCONFLICT, or 403
 * "cannot publish over the previously published versions"), so without a
 * pre-check a re-run — or a partial publish that is resumed — would fail on
 * the first package that had already gone out. scripts/publish-package.sh
 * calls this before `npm publish` and skips the publish when it prints
 * `published`.
 *
 * ## Contract
 *
 * `node scripts/npm-package-published.mjs <prepared-package-dir> <registry-url>`
 *
 * Reads `name` and `version` from `<dir>/package.json` (the prepared
 * `@ima-jin/*` copy, not the workspace manifest), then runs
 * `npm view <name>@<version> version --json --registry <url>`.
 *   - prints `published`   (exit 0) — that exact version exists.
 *   - prints `unpublished` (exit 0) — registry answered E404: no such version.
 *   - exits 1 with a message on stderr for ANYTHING else (auth failure,
 *     network error, registry 5xx, unparseable output). An unknown state is
 *     deliberately never treated as "unpublished" and never as "published":
 *     guessing either way could skip a publish or mask a real failure, so it
 *     fails the job visibly instead.
 *
 * The npm token reaches `npm view` only through the environment/.npmrc the
 * caller already set up for `npm publish`; this script never reads or prints
 * it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * Pure classification of an `npm view` result.
 * @param {{ status: number | null, stdout: string, stderr: string }} result
 * @returns {'published' | 'unpublished' | 'error'}
 */
export function classifyNpmView({ status, stdout, stderr }) {
  if (status === 0) {
    return stdout.trim() === '' ? 'error' : 'published';
  }
  // npm prints `npm error code E404` (older npm: `npm ERR! code E404`) when
  // the package or that specific version does not exist.
  if (/\bE404\b/.test(`${stderr}\n${stdout}`)) {
    return 'unpublished';
  }
  return 'error';
}

/** Default runner: shells out to the real npm. Injected in tests. */
export function runNpmView(name, version, registry) {
  const result = spawnSync(
    'npm',
    ['view', `${name}@${version}`, 'version', '--json', '--registry', registry],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: `${result.stderr ?? ''}${result.error ? String(result.error) : ''}`,
  };
}

/**
 * CLI body, returned as `{ code, out, err }` so it can be tested without
 * spawning a process or touching the real registry.
 */
export function check(argv, run = runNpmView) {
  const [dir, registry] = argv;
  if (!dir || !registry) {
    return { code: 1, out: '', err: 'usage: npm-package-published.mjs <package-dir> <registry-url>' };
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch (error) {
    return { code: 1, out: '', err: `cannot read ${join(dir, 'package.json')}: ${error.message}` };
  }
  const { name, version } = manifest;
  if (!name || !version) {
    return { code: 1, out: '', err: `${join(dir, 'package.json')} has no name/version` };
  }

  const result = run(name, version, registry);
  const state = classifyNpmView(result);
  if (state === 'error') {
    const detail = (result.stderr || result.stdout).trim();
    return {
      code: 1,
      out: '',
      err: `cannot determine whether ${name}@${version} is on ${registry} (npm view exit ${result.status}): ${detail}`,
    };
  }
  return { code: 0, out: state, err: '' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, out, err } = check(process.argv.slice(2));
  if (out) console.log(out);
  if (err) console.error(err);
  process.exit(code);
}
