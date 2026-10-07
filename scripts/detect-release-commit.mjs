#!/usr/bin/env node
/**
 * Release-commit detection for `.github/workflows/tag-release.yml` (#2685).
 *
 * ## Why this exists
 *
 * `tag-release.yml` used to read only HEAD^2's first line to decide whether a
 * push to main was a merged release PR. v0.8.15 had `main` merged into
 * `release/v0.8.15` before the PR merged, so HEAD^2 was
 * `Merge branch 'main' into release/v0.8.15` — not `release: v0.8.15`. The
 * check said "not a release", exited green, and no tag / prod deploy happened.
 * The #2622 manual recovery (dispatch with the merge sha) used the same check
 * and failed the same way.
 *
 * ## What it does
 *
 * Given the commit to inspect (`TARGET_SHA`):
 *
 *   1. Not a two-parent merge (squash / fast-forward / direct push, or a
 *      dispatch with the release commit's own sha): the commit itself is
 *      inspected. A first line starting `release: v` makes it a release commit
 *      and it is the tag target.
 *   2. Two-parent merge: walk the FIRST-parent chain of HEAD^2 (the merged
 *      branch), bounded to `MAX_WALK` commits and stopping at the merge-base
 *      with HEAD^1, and take the first commit whose first line starts
 *      `release: v`.
 *        - HEAD^2 itself is that commit (a plain release merge): behaves
 *          exactly as before — the tag target stays the merge commit.
 *        - found deeper (main was merged into the release branch): the tag
 *          target is that release commit, not the merge.
 *   3. Two-parent merge with no release commit found: if the merged branch is
 *      `release/v*` (parsed from the merge message
 *      `Merge pull request #N from <owner>/release/vX.Y.Z`) the job FAILS with
 *      an `::error::`. A green skip is never allowed for a release branch.
 *      Any other merge is a plain non-release merge (`is_release=false`).
 *
 * The version itself is still extracted afterwards by
 * `scripts/lib/parse-release-version.sh`, so a `release: v` line with a
 * malformed version also fails loudly.
 *
 * ## Usage
 *
 * `TARGET_SHA=<sha> node scripts/detect-release-commit.mjs`
 *
 * Results (`is_release`, `first_line`, `target_sha`) are appended to the file
 * named by `GITHUB_OUTPUT` (stdout `key=value` lines when it is unset).
 * Diagnostics and `::error::` annotations go to stdout; the exit code is 1 on
 * a release-branch merge with no release commit, and on bad input.
 *
 * Env overrides (for tests / non-standard checkouts):
 *   - `TARGET_SHA`           — commit to inspect (required)
 *   - `DETECT_WORKDIR`       — repo root (default: one level up from this file)
 *   - `GITHUB_OUTPUT`        — file to append results to
 *   - `GIT_BIN`              — absolute path to the git binary
 *
 * ## Sonar-clean notes
 *
 * No PATH-spawn (S4036): `git` is resolved to an absolute path via
 * `scripts/lib/git-version.mjs`, shared with the other CI guards.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGitBinary } from './lib/git-version.mjs';

export const RELEASE_COMMIT_PREFIX = 'release: v';
/** Upper bound on how many commits of the merged branch are inspected. */
export const MAX_WALK = 50;

const MERGE_PR_SUBJECT = /^Merge pull request #\d+ from [^/\s]+\/(release\/v\S*)$/;

/** First line of a commit message. */
function firstLineOf(message) {
  const newline = message.indexOf('\n');
  return (newline === -1 ? message : message.slice(0, newline)).trim();
}

/** Whether a commit's first line marks it as a release commit. */
export function isReleaseLine(line) {
  return line.startsWith(RELEASE_COMMIT_PREFIX);
}

/**
 * The `release/v*` branch a GitHub merge-commit message merged, or `undefined`
 * for any other message (`Merge pull request #N from <owner>/release/vX.Y.Z`).
 */
export function releaseBranchFromMergeMessage(message) {
  const match = MERGE_PR_SUBJECT.exec(firstLineOf(message));
  return match ? match[1] : undefined;
}

/**
 * Pure detection over an injected git reader.
 *
 * `repo` provides:
 *   - `parents(sha)`                  → string[] of parent shas
 *   - `message(sha)`                  → full commit message
 *   - `branchChain(tip, base, limit)` → [{ sha, message }] first-parent chain
 *                                       from `tip`, stopping at `base`
 *   - `mergeBase(a, b)`               → sha or undefined
 *
 * Returns `{ isRelease, firstLine, targetSha }` or `{ error }`.
 */
export function detectReleaseCommit(repo, target) {
  const parents = repo.parents(target);

  if (parents.length < 2) {
    const firstLine = firstLineOf(repo.message(target));
    return isReleaseLine(firstLine)
      ? { isRelease: true, firstLine, targetSha: target }
      : { isRelease: false, firstLine, targetSha: target };
  }

  const [mainParent, branchTip] = parents;
  const mergeMessage = repo.message(target);
  const base = repo.mergeBase(mainParent, branchTip);
  const chain = repo.branchChain(branchTip, base, MAX_WALK);

  const found = chain.find((commit) => isReleaseLine(firstLineOf(commit.message)));
  if (found) {
    const firstLine = firstLineOf(found.message);
    // Plain release merge: unchanged — tag the merge commit. Otherwise tag the
    // release commit found down the merged branch.
    const targetSha = found.sha === branchTip ? target : found.sha;
    return { isRelease: true, firstLine, targetSha };
  }

  const releaseBranch = releaseBranchFromMergeMessage(mergeMessage);
  if (releaseBranch) {
    return {
      error:
        `${target} merges release branch "${releaseBranch}" but no commit whose first line starts with ` +
        `"${RELEASE_COMMIT_PREFIX}" was found on it (first-parent walk of the merged branch, at most ${MAX_WALK} ` +
        `commits, stopping at the merge-base with the target branch). Refusing to skip a release silently — ` +
        `no tag and no prod deploy would happen. Re-run via workflow_dispatch with the release commit's sha ` +
        `once the branch is fixed.`,
    };
  }

  return { isRelease: false, firstLine: firstLineOf(chain[0]?.message ?? mergeMessage), targetSha: target };
}

// ── git-backed reader ────────────────────────────────────────────────────────

function gitReader(gitBin, root) {
  const git = (args) => execFileSync(gitBin, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return {
    parents(sha) {
      return git(['log', '-1', '--format=%P', sha]).trim().split(/\s+/).filter(Boolean);
    },
    message(sha) {
      return git(['log', '-1', '--format=%B', sha]);
    },
    mergeBase(a, b) {
      try {
        return git(['merge-base', a, b]).trim() || undefined;
      } catch {
        return undefined; // unrelated histories — no lower bound
      }
    },
    branchChain(tip, base, limit) {
      const args = ['log', '--first-parent', `--max-count=${limit}`, '--format=%H%x1f%B%x1e', tip];
      if (base) args.push(`^${base}`);
      return git(args)
        .split('\x1e')
        .map((record) => record.replace(/^\n/, ''))
        .filter((record) => record.trim() !== '')
        .map((record) => {
          const sep = record.indexOf('\x1f');
          return { sha: record.slice(0, sep), message: record.slice(sep + 1) };
        });
    },
  };
}

function emit(outputs) {
  const lines = Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join(''));
  else process.stdout.write(lines.join(''));
}

function main() {
  const target = process.env.TARGET_SHA;
  if (!target || !/^[0-9a-fA-F]{7,40}$/.test(target)) {
    console.log(`::error::TARGET_SHA is not a git commit sha: ${target ?? '(unset)'}`);
    return 1;
  }
  const root = process.env.DETECT_WORKDIR
    ? resolve(process.env.DETECT_WORKDIR)
    : resolve(dirname(fileURLToPath(import.meta.url)), '..');

  let result;
  try {
    const repo = gitReader(resolveGitBinary(), root);
    result = detectReleaseCommit(repo, target);
  } catch (err) {
    console.log(`::error::release-commit detection failed: ${err.message.split('\n')[0]}`);
    return 1;
  }

  if (result.error) {
    console.log(`::error::${result.error}`);
    return 1;
  }

  emit({ target_sha: result.targetSha, first_line: result.firstLine, is_release: String(result.isRelease) });
  if (result.isRelease) {
    console.log(`Release commit "${result.firstLine}" — tagging ${result.targetSha}.`);
  } else {
    console.log(`Not a release commit (first line: "${result.firstLine}") — nothing to do.`);
  }
  return 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
