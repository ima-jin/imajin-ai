#!/usr/bin/env node
/**
 * Version-bump-is-a-release-only-event guard (#2285).
 *
 * ## Why this exists
 *
 * Prod's footer once read `imajin 0.8.0+4161` while prod actually ran tag
 * `v0.7.1`/`v0.8.0` — the root `package.json` `version` field had been bumped
 * as a side effect of an unrelated feature PR (#2039), and nothing else in the
 * repo treated that as noteworthy. Tag and manifest had no relationship, and
 * nobody caught the drift until it showed up in production.
 *
 * Now that `scripts/build.sh` derives the displayed version from `git
 * describe --tags` (tag is truth — see `.github/workflows/release.yml` and
 * `packages/ui/src/BuildInfo.tsx`), a stray `package.json` version bump can no
 * longer corrupt the displayed build version. But it can still corrupt
 * `.github/workflows/release.yml`'s own `pnpm -r version <bump>` step, which
 * bumps every manifest **in lockstep** from whatever is on `main` — a
 * feature PR that already touched one package's version unbalances that.
 *
 * ## What it checks
 *
 * Every `package.json` tracked in both this ref and `origin/main` has its
 * `"version"` field compared. Any difference fails the run UNLESS the head
 * commit's message starts with `release:` — the one and only shape of commit
 * the Release workflow itself produces (`release: vX.Y.Z`, see
 * release.yml). A brand-new `package.json` (not present on `origin/main` at
 * all, e.g. a newly added package) is not a "bump" and is skipped.
 *
 * ## Which commit counts as "head"
 *
 * A pull_request run checks out GitHub's synthetic merge commit
 * (`refs/pull/N/merge`), whose second parent (`HEAD^2`) is the actual last
 * commit pushed to the PR branch — that's the one a contributor wrote, and
 * the one whose message this guard should read. When there is no second
 * parent (a direct push to `main`, e.g. the Release workflow's own commit,
 * or a squash-merged history), `HEAD` itself is used.
 *
 * ## Sonar-clean notes
 *
 * - No PATH-spawn (S4036): `git` is resolved to an absolute path up front
 *   (env override or a fixed list of known install locations) rather than
 *   left to PATH lookup — see `scripts/lib/git-version.mjs`, shared with
 *   `scripts/ci-guard-version-tag-sync.mjs` and `scripts/bump-workspace-version.mjs`.
 *
 * ## Usage
 *
 * `node scripts/ci-guard-version-bump.mjs`
 *
 * Env overrides (for tests / non-standard checkouts):
 *   - `CI_GUARD_WORKDIR`               — repo root (default: one level up from this file)
 *   - `CI_GUARD_VERSION_BASE_REF`      — git ref to diff against (default: `origin/main`)
 *   - `CI_GUARD_VERSION_HEAD_REF`      — git ref to treat as the PR tip (default: `HEAD`)
 *   - `CI_GUARD_HEAD_COMMIT_MESSAGE`   — skip git entirely and use this as the head commit message
 *   - `GIT_BIN`                        — absolute path to the git binary
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGitBinary, ensureSafeDirectory } from './lib/git-version.mjs';

const ROOT = process.env.CI_GUARD_WORKDIR
  ? resolve(process.env.CI_GUARD_WORKDIR)
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE_REF = process.env.CI_GUARD_VERSION_BASE_REF || 'origin/main';
const HEAD_REF = process.env.CI_GUARD_VERSION_HEAD_REF || 'HEAD';
const RELEASE_PREFIX = 'release:';

function git(gitBin, root, args) {
  return execFileSync(gitBin, args, { cwd: root, encoding: 'utf8' });
}

function refExists(gitBin, root, ref) {
  try {
    execFileSync(gitBin, ['rev-parse', '--verify', '--quiet', ref], { cwd: root, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Splits a ref like "origin/main" into `["origin", "main"]` for `git fetch`. */
function splitRemoteRef(ref) {
  const slash = ref.indexOf('/');
  return slash === -1 ? ['origin', ref] : [ref.slice(0, slash), ref.slice(slash + 1)];
}

/** Fetches a missing base ref shallowly (fresh/shallow checkouts never have origin/main locally). */
function fetchBaseRef(gitBin, root, baseRef) {
  const [remote, branch] = splitRemoteRef(baseRef);
  execFileSync(gitBin, ['fetch', remote, `${branch}:refs/remotes/${remote}/${branch}`, '--depth=1'], {
    cwd: root,
    stdio: 'pipe',
  });
}

// ── data gathering ───────────────────────────────────────────────────────────

/** Lists every package.json tracked at `ref`, repo-root-relative. */
function listPackageJsonFiles(gitBin, root, ref) {
  const out = git(gitBin, root, ['ls-tree', '-r', '--name-only', ref]);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line === 'package.json' || line.endsWith('/package.json'))
    .filter((line) => !line.includes('node_modules/'));
}

/** Returns the "version" field of `filePath` as committed at `ref`, or `undefined` if absent/unparsable. */
function readVersionAt(gitBin, root, ref, filePath) {
  let raw;
  try {
    raw = git(gitBin, root, ['show', `${ref}:${filePath}`]);
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw).version;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the message of the commit a human actually wrote for this PR.
 * See the "Which commit counts as 'head'" note above for why `HEAD^2` is
 * preferred when it exists.
 */
function resolveHeadCommitMessage(gitBin, root, headRef) {
  if (process.env.CI_GUARD_HEAD_COMMIT_MESSAGE !== undefined) {
    return process.env.CI_GUARD_HEAD_COMMIT_MESSAGE;
  }
  const prBranchTip = `${headRef}^2`;
  const ref = refExists(gitBin, root, prBranchTip) ? prBranchTip : headRef;
  return git(gitBin, root, ['log', '-1', '--format=%B', ref]);
}

// ── main ─────────────────────────────────────────────────────────────────────

function fail(message, details = []) {
  console.error(`\nFAIL: ${message}\n`);
  for (const d of details) console.error(`  - ${d}`);
  process.exit(1);
}

function main() {
  let gitBin;
  try {
    gitBin = resolveGitBinary();
  } catch (err) {
    fail(err.message);
    return;
  }

  ensureSafeDirectory(gitBin, ROOT);

  if (!refExists(gitBin, ROOT, BASE_REF)) {
    try {
      fetchBaseRef(gitBin, ROOT, BASE_REF);
    } catch (err) {
      fail(`could not resolve or fetch base ref "${BASE_REF}": ${err.message.split('\n')[0]}`);
      return;
    }
  }

  const headMessage = resolveHeadCommitMessage(gitBin, ROOT, HEAD_REF).trim();
  const isReleaseCommit = headMessage.toLowerCase().startsWith(RELEASE_PREFIX);

  const headFiles = new Set(listPackageJsonFiles(gitBin, ROOT, HEAD_REF));
  const baseFiles = new Set(listPackageJsonFiles(gitBin, ROOT, BASE_REF));
  // A package.json that doesn't exist on the base ref is a new package, not
  // a bump — nothing to compare it against.
  const filesToCheck = [...headFiles].filter((f) => baseFiles.has(f)).sort((a, b) => a.localeCompare(b));

  const violations = [];
  for (const filePath of filesToCheck) {
    const headVersion = readVersionAt(gitBin, ROOT, HEAD_REF, filePath);
    const baseVersion = readVersionAt(gitBin, ROOT, BASE_REF, filePath);
    if (headVersion === undefined || baseVersion === undefined) continue;
    if (headVersion !== baseVersion) {
      violations.push(`${filePath}: version changed from "${baseVersion}" to "${headVersion}"`);
    }
  }

  if (violations.length === 0) {
    console.log(`PASS: no package.json "version" field differs from ${BASE_REF}.`);
    process.exit(0);
    return;
  }

  if (isReleaseCommit) {
    console.log(
      `PASS: ${violations.length} version field(s) differ from ${BASE_REF}, but the head commit message ` +
        `starts with "${RELEASE_PREFIX}" (the Release workflow's own commit), so this is allowed:`,
    );
    for (const v of violations) console.log(`  - ${v}`);
    process.exit(0);
    return;
  }

  fail(
    `${violations.length} package.json "version" field(s) differ from ${BASE_REF}, but the head commit ` +
      `message does not start with "${RELEASE_PREFIX}". Feature PRs must never bump version fields — ` +
      `versions are only ever changed by the Release workflow (.github/workflows/release.yml), never by hand.`,
    violations,
  );
}

main();
