#!/usr/bin/env node
/**
 * Resolves .github/workflows/publish-packages.yml's run parameters (#1982).
 *
 * ## Why this exists
 *
 * Before this, the branching between a `packages-v*` tag push (always: the
 * four SDK packages, GitHub Packages only, never a dry run) and a
 * `workflow_dispatch` (package/registries/dry_run inputs) lived entirely as
 * inline `bash` inside the workflow's "Resolve run parameters" step. That
 * logic had never actually been exercised end-to-end: no `packages-v*` tag
 * has ever been pushed in this repo (`git tag -l 'packages-v*'` is empty), so
 * the tag-push branch was unverified except by reading the YAML. Pulling it
 * into a plain Node module makes it something `scripts/__tests__/
 * resolve-publish-params.test.mjs` can actually assert against, instead of
 * only trusting a diff.
 *
 * ## What it does
 *
 * `resolvePublishParams` mirrors the original bash exactly:
 *   - `push` (a `packages-v*` tag): `list` = `sdkPackages`, GitHub Packages
 *     only, never a dry run. `NPM_TOKEN` is never read on this path.
 *   - `workflow_dispatch` — or a `workflow_call` (#2578): `list` = `allPackages` when `inputPackage` is
 *     `"all"`, else `inputPackage` itself; `doNpmjs`/`doGhp` follow
 *     `inputRegistries` (`both` / `npmjs` / `github-packages`); `dryRun`
 *     passes `inputDryRun` through unchanged.
 *
 * ## Called from another workflow (#2578)
 *
 * Inside a reusable workflow, `github.event_name` and `github.ref` are the
 * CALLER's, not `workflow_call`'s. tag-release.yml runs on `push` (to main),
 * so the reusable publish job also sees `GITHUB_EVENT_NAME=push` — which by
 * event name alone is indistinguishable from a `packages-v*` tag push, and
 * would silently publish the wrong package set to the wrong registry. The ref
 * disambiguates: a real tag push has `GITHUB_REF=refs/tags/packages-v*`, the
 * release call has `refs/heads/main`. The tag path is therefore keyed on
 * BOTH event and ref, so it can never be reached from inputs (and a tag push
 * still can never reach npmjs, whatever stale inputs it carries — #1982).
 * Anything else is input-driven, and an input-driven run with no `package`
 * is an error rather than a guess.
 *
 * No in-workflow version bump exists here, deliberately — see
 * docs/packages/PUBLISHING.md's "Maintainer: bump, tag, publish" section and
 * the root `AGENTS.md` "Versioning" section (#2285, tag-as-truth): every
 * package.json version in this repo, including the four SDK packages, is
 * bumped only by the Release workflow, in lockstep, via a normal reviewed
 * PR. Adding a commit-message- or workflow-input-driven bump here would
 * create a second, competing way to change a version, and any package.json
 * diff it produced would be rejected by `scripts/ci-guard-version-bump.mjs`
 * unless the commit happened to start with `release:` — the one shape of
 * commit that guard reserves for the Release workflow's own output.
 *
 * ## Usage
 *
 * `node scripts/resolve-publish-params.mjs`
 *
 * Reads (all optional except `eventName`, which defaults to
 * `GITHUB_EVENT_NAME`):
 *   - `GITHUB_EVENT_NAME`   — `push` or `workflow_dispatch`
 *   - `GITHUB_REF`          — the triggering ref; a `refs/tags/packages-v*`
 *     ref on a `push` selects the SDK tag path
 *   - `INPUT_PACKAGE`       — `inputs.package` (workflow_dispatch only)
 *   - `INPUT_REGISTRIES`    — `inputs.registries` (workflow_dispatch only)
 *   - `INPUT_DRY_RUN`       — `inputs.dry_run` (workflow_dispatch only)
 *   - `ALL_PACKAGES`        — space-separated package list
 *   - `SDK_PACKAGES`        — space-separated package list
 *   - `GITHUB_OUTPUT`       — path to append `key=value` lines to; when
 *     unset, the resolved lines are printed to stdout instead (local preview)
 */

import { appendFileSync } from 'node:fs';

const PACKAGES_TAG_REF_PREFIX = 'refs/tags/packages-v';

/**
 * Pure resolution — no env/fs access, so it's trivial to unit test every
 * branch without a real GitHub Actions context.
 */
export function resolvePublishParams({
  eventName,
  ref,
  inputPackage,
  inputRegistries,
  inputDryRun,
  allPackages,
  sdkPackages,
}) {
  if (eventName === 'push' && typeof ref === 'string' && ref.startsWith(PACKAGES_TAG_REF_PREFIX)) {
    return { list: sdkPackages, doNpmjs: false, doGhp: true, dryRun: false };
  }

  if (!inputPackage) {
    throw new Error(
      `No publish package given for event "${eventName}" on ref "${ref}": expected a ` +
        `${PACKAGES_TAG_REF_PREFIX}* tag push, or a dispatch/call with a package input.`,
    );
  }

  const list = inputPackage === 'all' ? allPackages : inputPackage;
  const doNpmjs = inputRegistries !== 'github-packages';
  const doGhp = inputRegistries !== 'npmjs';
  const dryRun = inputDryRun === true || inputDryRun === 'true';

  return { list, doNpmjs, doGhp, dryRun };
}

/** Formats resolved params as `$GITHUB_OUTPUT`-style `key=value` lines. */
export function formatAsGithubOutput({ list, doNpmjs, doGhp, dryRun }) {
  return [`list=${list}`, `do_npmjs=${doNpmjs}`, `do_ghp=${doGhp}`, `dry_run=${dryRun}`];
}

function main() {
  const params = resolvePublishParams({
    eventName: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF,
    inputPackage: process.env.INPUT_PACKAGE,
    inputRegistries: process.env.INPUT_REGISTRIES,
    inputDryRun: process.env.INPUT_DRY_RUN,
    allPackages: process.env.ALL_PACKAGES,
    sdkPackages: process.env.SDK_PACKAGES,
  });

  const lines = formatAsGithubOutput(params);
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath) {
    appendFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
  }
  for (const line of lines) {
    console.log(line);
  }
}

const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  main();
}
