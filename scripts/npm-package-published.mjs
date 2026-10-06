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
 * `@ima-jin/*` copy, not the workspace manifest), then GETs the package's
 * (abbreviated) packument from the registry — the same document `npm view`
 * reads, fetched directly so no `npm` binary is resolved through `PATH`:
 *   - prints `published`   (exit 0) — 200 and `versions[<version>]` exists.
 *   - prints `unpublished` (exit 0) — 404 (package never published), or 200
 *     without that version.
 *   - exits 1 with a message on stderr for ANYTHING else (401/403, 5xx,
 *     network error, unparseable body). An unknown state is deliberately
 *     never treated as "unpublished" and never as "published": guessing
 *     either way could skip a publish or mask a real failure, so it fails the
 *     job visibly instead.
 *
 * Auth: when `NODE_AUTH_TOKEN` is set (the same variable the publish step
 * uses) it is sent as a bearer token to the registry URL it was given — the
 * only place it goes — which GitHub Packages requires even for reads. It is
 * never printed, and never appears in an error message.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ABBREVIATED_PACKUMENT = 'application/vnd.npm.install-v1+json';

/** `@ima-jin/logger` -> `@ima-jin%2Flogger`, the form every npm registry accepts. */
export function packumentUrl(registry, name) {
  let end = registry.length;
  while (end > 0 && registry[end - 1] === '/') end -= 1;
  return `${registry.slice(0, end)}/${name.replace('/', '%2F')}`;
}

/**
 * Looks the version up. Returns `'published'` or `'unpublished'`; throws on
 * anything it cannot positively classify.
 *
 * @param {{ name: string, version: string, registry: string, token?: string, fetchImpl?: typeof fetch }} args
 */
export async function lookupVersion({ name, version, registry, token, fetchImpl = fetch }) {
  const headers = { Accept: ABBREVIATED_PACKUMENT };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetchImpl(packumentUrl(registry, name), { headers });

  if (response.status === 404) return 'unpublished';
  if (response.status !== 200) {
    throw new Error(`registry answered HTTP ${response.status}`);
  }

  let packument;
  try {
    packument = await response.json();
  } catch {
    throw new Error('registry returned a body that is not valid JSON');
  }
  const versions = packument?.versions;
  if (!versions || typeof versions !== 'object') {
    throw new Error('registry response has no "versions" map');
  }
  return Object.hasOwn(versions, version) ? 'published' : 'unpublished';
}

/**
 * CLI body, returned as `{ code, out, err }` so it can be tested without
 * spawning a process or touching a real registry.
 */
export async function check(argv, { token, fetchImpl } = {}) {
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

  try {
    const state = await lookupVersion({ name, version, registry, token, fetchImpl });
    return { code: 0, out: state, err: '' };
  } catch (error) {
    return {
      code: 1,
      out: '',
      err: `cannot determine whether ${name}@${version} is on ${registry}: ${error.message}`,
    };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, out, err } = await check(process.argv.slice(2), { token: process.env.NODE_AUTH_TOKEN });
  if (out) console.log(out);
  if (err) console.error(err);
  process.exit(code);
}
