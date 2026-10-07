# Publishing `packages/*` to npm

Reference notes from the npm-publish epic ([#1573](https://github.com/ima-jin/imajin-ai/issues/1573)). Read this before normalizing another package for publication — several of these were discovered the hard way (real build failures caught before merge, not theoretical).

## Cutting a release (tag is truth — #2285)

This repo's release version and the repo's npm-package versions (below) are two separate, unrelated concerns — this section is about the FORMER: the `vX.Y.Z` tag that decides what `scripts/build.sh` displays as the running build version and what `deploy-prod.yml` ships to production.

**Releases are cut ONLY through this three-workflow pipeline** — nobody creates a `vX.Y.Z` tag by hand, nobody pushes to `main` outside a normal PR, and no PR ever hand-edits a `package.json` `"version"` field (see the "Versioning" section of the root `AGENTS.md`). No step in this pipeline uses a bypass token or a PAT; every workflow authenticates with the default, ephemeral `secrets.GITHUB_TOKEN`, and the only human approval gate is `deploy-prod.yml`'s existing `production` GitHub Environment reviewer — the exact same gate every other prod deploy already goes through.

1. **[`release.yml`](../.github/workflows/release.yml)** — `workflow_dispatch` (`gh workflow run release.yml -f bump=minor|patch`, default `minor`, or the GitHub Actions UI), gated to `main`. It:
   - Reads the **latest `vX.Y.Z` git tag** reachable from `main` (`git describe --tags --abbrev=0 --match 'v[0-9]*'`, leading `v` stripped) as the single source of truth, and bumps it by the chosen `minor`/`patch` type — NOT root `package.json`'s own version (#2349). `package.json` used to be the source of truth, but that broke the moment a release was cut outside this workflow: `v0.8.3`–`v0.8.5` were pushed as manual annotated tags (hot-fix cycles) while `package.json` stayed at `0.8.2`, so the next `bump=patch` dispatch computed `v0.8.3` — already tagged — and "Guard against re-using an existing tag" correctly refused to run. Reading the tag instead makes this self-healing: whatever the latest tag is, that's what the next bump is computed from, regardless of what `package.json` says. Falls back to root `package.json`'s version only when no `vX.Y.Z` tag exists yet at all (a brand-new repo before its first release).
   - Writes that exact new version into **every** `package.json` in the workspace (root + every `apps/*`/`packages/*` manifest) via `scripts/bump-workspace-version.mjs` — true lockstep, all packages land on the same `X.Y.Z`, regardless of what they were at before. See that script's header comment for why this is a small dedicated Node script instead of the originally-proposed `pnpm -r version <bump>`: that command is a no-op on the pnpm version this repo pins (`pnpm@9.15.0`), and wouldn't produce lockstep even if it worked, given this repo's real per-package version divergence.
   - Commits to a new `release/vX.Y.Z` branch with message `release: vX.Y.Z` — that exact prefix is what lets the commit past `scripts/ci-guard-version-bump.mjs` (see below), the same guard that blocks every other PR from touching a version field.
   - Pushes that branch (never `main`) and opens a normal PR into `main` titled `release: vX.Y.Z`, then explicitly dispatches `ci.yml` against the branch so the PR's required status checks actually populate (a PR opened via the default `GITHUB_TOKEN` doesn't trigger other workflows' `pull_request` events, so without this the checks would sit pending forever — `workflow_dispatch` is exempt from that suppression, and GitHub matches required checks to a commit SHA regardless of which trigger produced them).
2. **A human reviews and merges the `release: vX.Y.Z` PR** exactly like any other PR — same branch protection, same required checks, no bypass.
3. **[`tag-release.yml`](../.github/workflows/tag-release.yml)** — runs on every push to `main`, but only acts when the real merged commit's message starts with `release: v` (read off `HEAD^2` when `main` is merged via GitHub's default "create a merge commit" strategy, the same technique `ci-guard-version-bump.mjs` uses — a merge commit's own generic "Merge pull request #N ..." message is not the release commit's message). When it matches, it creates the annotated tag `vX.Y.Z` at that commit, pushes the tag, and explicitly dispatches `deploy-prod.yml` against that tag (`gh workflow run deploy-prod.yml --ref vX.Y.Z -f ref=vX.Y.Z`) — needed because a tag pushed with the default `GITHUB_TOKEN` does NOT fire `deploy-prod.yml`'s own `push: tags: ['v*']` trigger (same GITHUB_TOKEN-suppression rule as above). Idempotent: skips tag creation if it already exists, and won't double-dispatch a deploy for a tag it already dispatched one for.
4. **`deploy-prod.yml` runs as normal**, held at its existing `environment: production` required-reviewer gate until a reviewer approves — unchanged by any of this.
5. **Publishing to npm happens automatically (#2578)** — see "Automatic npm publish on a release tag" below. There is no manual publish step in a release.

### Automatic npm publish on a release tag (#2578)

Before #2578, `release.yml` bumped every `package.json` in lockstep but publishing was a hand-run `workflow_dispatch` of `publish-packages.yml`, so npm drifted behind `main` (`@ima-jin/logger` sat at `0.8.7` while `main` was at `0.8.13`, which made `@ima-jin/auth@0.8.13` uninstallable). Now, in the same `tag-release.yml` run that creates the `vX.Y.Z` tag, a second job — `publish-npm` — calls `publish-packages.yml` as a reusable workflow (`workflow_call`) with `package: all`, `registries: npmjs` and `ref: vX.Y.Z`. There is no second copy of the publish logic: the manual dispatch, the `packages-v*` tag path and this call all run the same job.

- **What gets published:** `ALL_PACKAGES` in `publish-packages.yml` — the single list of what is publishable — to npmjs only, at exactly the version committed at the tag (the job checks out the tag itself, so a later push to `main` can't change what ships). GitHub Packages is not touched by this path.
- **Auth (#1589):** OIDC Trusted Publishing first, with provenance — see "npm Trusted Publishing (OIDC)" below. The legacy org `NPM_TOKEN`, still passed by `tag-release.yml` as `secrets: NPM_TOKEN: ${{ secrets.NPM_TOKEN }}`, is now only an optional per-package fallback. No new secret.
- **Idempotent:** `scripts/publish-package.sh` runs `scripts/npm-package-published.mjs` before every `npm publish`. It fetches the package's abbreviated packument straight from the target registry (the document `npm view` reads, using `NODE_AUTH_TOKEN` as a bearer token when set — GitHub Packages needs it even for reads): a version listed there is skipped with a log line, not a failure; a 404 (never published) or a packument without that version means "not published yet" and the publish proceeds. Any other answer (401/403, 5xx, network error, malformed body) fails the step rather than guessing — an unknown state is never treated as published or as unpublished. Re-running the `publish-npm` job after a partial failure therefore resumes where it stopped.
- **Failure is visible:** a failed publish fails the `publish-npm` job and so the `Tag Release` run. Packages publish in dependency order and the loop stops at the first failure, so a half-published release shows up as a red run, never a silent success; fix the cause and re-run the failed job.
- **Independent of the deploy:** `publish-npm` is a separate job that runs after the tag exists. It does not wait for, and cannot bypass or delay, `deploy-prod.yml`'s `production` reviewer approval, and a publish failure does not stop the deploy dispatch (which happens earlier, in the tagging job). It doesn't touch the release-PR review flow either.
- **Backfilling by hand** (e.g. a package that was never published at the current version) is still `gh workflow run publish-packages.yml -f package=<pkg> -f registries=npmjs`; thanks to the skip check it is safe to run against versions that already exist.

`scripts/build.sh` derives `NEXT_PUBLIC_VERSION` from `git describe --tags --abbrev=0 --match 'v[0-9]*'` (#2287 — restricted to version-shaped tags so a future non-version tag can never hijack the footer; falling back to the root `package.json` version only on an untagged checkout, then `dev`) — see `packages/ui/src/BuildInfo.tsx` and `scripts/lib/build-version.sh`. As of #2349 landing, root `package.json` was synced to `0.8.5` (matching the latest tag, `v0.8.5`, itself pushed by hand as a hot-fix workaround) via a one-time `release: v0.8.5` commit, so the first `release.yml` dispatch after merge (`bump=patch`) computes `v0.8.6`, not a re-derivation of `v0.8.3`.

### The CI guards that keep this true

**`scripts/ci-guard-version-bump.mjs`** runs as a step in `ci.yml`'s `CI Guards` job on every PR. It compares every `package.json` `"version"` field against `origin/main`; any difference fails the job UNLESS the PR's actual head commit message (read off `HEAD^2` on a pull_request's synthetic merge-commit checkout, so a generic "Merge ... into ..." message never masks it) starts with `release:`. See `scripts/__tests__/ci-guard-version-bump.test.mjs` for the passing/failing/release-exempt cases this covers.

**`scripts/ci-guard-version-tag-sync.mjs`** (#2349) runs alongside it in the same job. It fails when root `package.json`'s `"version"` is behind the latest `vX.Y.Z` tag — the exact drift that broke `release.yml`'s `bump=patch` dispatch when hot-fix tags were pushed by hand without a matching `package.json` sync. It deliberately fails loudly rather than self-healing: the fix is always the same one-time `release: vX.Y.Z` sync commit, and a CI-driven auto-commit would need its own bypass token and its own exemption in `ci-guard-version-bump.mjs`, for a situation that should already never happen per the "Deploy guardrails" section of the root `AGENTS.md`. See `scripts/__tests__/ci-guard-version-tag-sync.test.mjs`.

## Two registries, one canonical

`.github/workflows/publish-packages.yml` publishes each selected package to **two** registries ([#1595](https://github.com/ima-jin/imajin-ai/issues/1595)):

- **npmjs.org — canonical.** The only install path. `imajin-cli`, `fixready`, and `karaoke` install `@ima-jin/*` from here anonymously, with no auth and no `.npmrc`. Authenticated with OIDC Trusted Publishing and published with `--provenance` (#1589); the legacy `secrets.NPM_TOKEN` is only an optional fallback.
- **`npm.pkg.github.com` — visibility only.** Its sole purpose is populating the `ima-jin/imajin-ai` → **Packages** sidebar, which GitHub renders only for packages actually hosted on GitHub Packages (the `repository` + `directory` fields give the npm→GitHub backlink on the npmjs page, but do nothing for the sidebar). Nothing installs from here. Authenticated with the ephemeral `GITHUB_TOKEN` — **never a PAT**; publishing from a workflow in this repo is also what auto-connects each package to the repo. Requires `packages: write` on the job.

Both publishes run from the same prepared tarball via `scripts/publish-package.sh <pkg> <registry-url> <dry-run>`, in separate steps so each registry's token is only in scope for its own step. npmjs goes first, so a GitHub Packages failure can never block the canonical publish.

### The `packages-v*` tag path (#1982)

Pushing a `packages-vX.Y.Z` tag runs the same job with fixed parameters instead of `workflow_dispatch` inputs: it always publishes exactly the four out-of-repo SDK packages (`auth`, `config`, `logger`, `ui`), to **GitHub Packages only**, using `GITHUB_TOKEN` — `NPM_TOKEN` is never read on that path. This is the path an extracted app (e.g. `dykil`, #1985) actually installs from; see `docs/packages/PUBLISHING.md` for the consumer-facing `.npmrc` setup. Bump the four packages' versions and merge that before pushing the tag: this workflow has no version-bump step at all, for either trigger (#2286's tag-as-truth philosophy applied to packages, same as the repo-release pipeline above — one way to change a version, a normal PR). It always publishes exactly the version already committed in each package's `package.json`.

### The `registries` dispatch input

Defaults to `both`; `npmjs` and `github-packages` publish to just one. The single-registry options date from when **npm returned a 409 for a version that already exists**, failing the whole step — so publishing a version that was live on one registry but missing from the other (e.g. the original GitHub Packages backfill of `0.8.0`/`0.6.1`) required skipping the registry that already had it. Since #2578, `scripts/publish-package.sh` skips a version that is already on the target registry instead of failing, so `both` is safe to re-run too; the single-registry options remain for when you simply want only one (the automatic release publish uses `npmjs`).

`.npmrc` note: `actions/setup-node` only writes auth for `registry.npmjs.org`, so `publish-package.sh` writes a throwaway project-level `.npmrc` into the temp publish dir for the GitHub Packages leg. The `${NODE_AUTH_TOKEN}` in it is single-quoted on purpose — npm expands it when reading the file, so no token value ever lands on disk, and npm never packs `.npmrc` into a tarball. Do not "fix" it into a real interpolation.

## npm Trusted Publishing (OIDC) — #1589

Per #1589, npm is retiring 2FA-bypass "Automation" tokens (the issue gives ~January 2027 as the date they stop being able to publish; that date is taken from the issue, not re-verified here), so npmjs.org publishes no longer *depend* on the long-lived `NPM_TOKEN`. They authenticate with **GitHub Actions OIDC** instead: the job presents a GitHub-issued OIDC token and npm, per its [Trusted Publishing docs][npm-tp], exchanges it for a short-lived credential, trying that before falling back to traditional tokens. Publishes are made with `--provenance` (a Sigstore attestation tying the tarball to this repo, workflow and commit — see [npm's provenance docs][npm-prov]); per those docs, provenance is generated automatically for Trusted Publishing publishes as well. No long-lived credential is needed for the OIDC path.

> **Sourcing note.** Statements below about npm's behaviour are linked to npm's documentation (see "Sources" at the end of this section) or marked *unverified* where they are not. npm's Trusted Publishing behaviour has changed over time and some of it is not covered by npm's docs at all — check the npmjs.com UI and the linked pages before relying on a detail, and prefer what the first real release run shows (see "Verifying" below).

### What the workflow does

- `publish-packages.yml`'s job has `id-token: write` (alongside `contents: read`, `packages: write`). `tag-release.yml`'s `publish-npm` job grants the same, because a reusable workflow can't hold more permission than its caller.
- A step installs an exact, pinned npm (`npm@11.21.0`, `--ignore-scripts`) and fails the job if npm is below **11.5.1**. [npm's docs][npm-tp] state Trusted Publishing requires npm CLI 11.5.1+ and Node 22.14.0+; Node 22's bundled npm has been the npm 10.x line, which is older than 11.5.1 (check `npm --version` on the runner), which is why the upgrade and the asserted floor exist. Pinned exactly, not `latest`, so a future npm release can't break a release job; bump it deliberately (it must support the job's Node 22 — the pinned version's `engines.node` is `^20.17.0 || >=22.9.0`).
- `scripts/publish-package.sh` publishes to npmjs with `--access public --provenance`. It does **not** rely on `actions/setup-node`'s `.npmrc`. Whether `setup-node`'s `registry-url` handling (an `_authToken=${NODE_AUTH_TOKEN}` line, plus a placeholder `NODE_AUTH_TOKEN` in some versions) prevents npm from attempting the OIDC exchange is **disputed**: some users report it does ([actions/setup-node#1551][setup-node-1551], [#1477][setup-node-1477]); GitHub's maintainers there report OIDC publishing working with a dummy token present. We did not try to settle it — we sidestep it by not depending on that file. Each attempt gets its own throwaway npm user config — the OIDC attempt has no `_authToken` at all; the fallback attempt's `_authToken` is an `${ENV_VAR}` reference that npm expands in memory (no token ever lands on disk or in logs).
- GitHub Packages is unchanged: ephemeral `GITHUB_TOKEN`, and no `--provenance`. (npm's provenance docs describe the npm registry flow; whether GitHub Packages accepts npm provenance is *unverified* here, so the flag is deliberately not passed to it.)
- `scripts/prepare-npm-publish.mjs` adds `repository` (`git+https://github.com/ima-jin/imajin-ai.git` + `directory`) to the **publish copy** when a package's manifest omits it (`auth` and `logger` do). [npm's provenance docs][npm-prov] require `package.json` to have a public `repository` that matches (case-sensitive) where the publish comes from; a mismatch is reported in the wild to fail the publish with a 422 *(from third-party reports, unverified against npm's docs)*. No `package.json` in the repo is touched — the field exists only in the publish copy (covered by tests that check the source manifest is byte-identical after a run).

### Fallback behavior (until the operator has finished cut-over)

For each package on npmjs, `publish-package.sh` tries OIDC first:

1. **OIDC succeeds** → published with provenance; log line `Authenticated via OIDC Trusted Publishing`. `NPM_TOKEN` is never read.
2. **OIDC fails and the `NPM_TOKEN` secret exists** → a `::warning::` annotation names the package, then the publish is retried **once** with the token (still with `--provenance`; log line `Authenticated via legacy NPM_TOKEN fallback`). A `::warning::` in a run means that package still has no (or a broken) Trusted Publisher.
3. **OIDC fails and there is no `NPM_TOKEN`** → `::error::` and the step fails, like any publish failure (see "Failure is visible" above). Re-run after fixing the package's Trusted Publisher config; already-published versions are skipped.

The skip-if-already-published check is unaffected, so a retry or re-run never double-publishes. A **dry run** (`dry_run=true`) does not perform the OIDC exchange, so it cannot validate Trusted Publisher configuration — only a real publish can.

### Operator steps (npmjs.org — not doable from this repo)

The npm owner of the `@ima-jin` scope must do this once **per package**. Publishable packages are `ALL_PACKAGES` in `publish-packages.yml`: `cid`, `tokens`, `config`, `ui`, `vault-core`, `db`, `fair`, `auth-client`, `auth`, `logger` (published as `@ima-jin/<name>`).

1. On npmjs.com open `https://www.npmjs.com/package/@ima-jin/<name>/access` → **Trusted Publisher** → **GitHub Actions**.
2. Fill in exactly:
   - Organization or user: `ima-jin`
   - Repository: `imajin-ai`
   - Workflow filename: see step 3 (filename only, with `.yml`; no path)
   - Environment name: leave empty (the publish job uses no GitHub Environment)
   - Allowed actions: **`npm publish`** must be ticked. Per [npm's docs][npm-tp], configurations created after 3 Sep 2026 are automatically set to allow `npm stage publish`, and you choose whether to *also* permit direct `npm publish` — this workflow uses plain `npm publish`, so make sure it is permitted. (Staged publishing is out of scope here.)
3. **Register both workflow filenames**, if npm lets you add more than one publisher to a package:
   - `tag-release.yml` — the automatic release publish (`publish-npm` calls `publish-packages.yml` as a reusable workflow).
   - `publish-packages.yml` — manual `workflow_dispatch` backfills.

   Why two, and the caveats — **both points are unverified for this repo until a real run proves them**:
   - *Which filename is checked.* npm's troubleshooting guidance, as quoted in [npm/documentation#1755][npm-doc-1755], says that for `workflow_call` (and `workflow_dispatch`) the validation uses the **calling** workflow's name rather than the workflow that contains the publish command. I could not retrieve that troubleshooting section directly; treat it as *per npm docs at time of writing, unverified*. If correct, the release path authenticates as `tag-release.yml`.
   - *How many publishers.* npm's docs disagree: the [Trusted Publishing page][npm-tp] says a package can have up to 10 publishers, while the [`npm trust` CLI page][npm-trust] says "Currently, the registry only supports one configuration per package.". Check what the npmjs.com UI (or `npm trust list @ima-jin/<name>`) actually allows. If only one is allowed, register `tag-release.yml` (the path every release uses); manual dispatches for that package then take the token-fallback path until a second publisher is possible.

   Don't rename either workflow file afterwards — the configuration refers to the workflow by filename (the filename is a required field in [npm's setup docs][npm-tp]), so a rename would orphan it.
4. Optional CLI equivalent. Per the [`npm trust` docs][npm-trust] it needs npm 11.15.0+ and account-level 2FA: `npm trust github @ima-jin/<name> --repo ima-jin/imajin-ai --file tag-release.yml --allow-publish`, repeated with `--file publish-packages.yml` if multiple are allowed. Flags are as documented there; re-check `npm trust --help` for your installed version.
5. Per [npm's docs][npm-tp], a new configuration must complete its first successful publish within 2 days or it expires and can't be used or edited (delete and recreate it). Treat the ~2 day figure as *per npm docs at time of writing* and verify promptly (next section).

### Verifying a package (acceptance test)

The version in the package's `package.json` must not already be on npm (an existing version is skipped, which proves nothing). For a package whose version is unpublished, run a real publish:

```bash
gh workflow run publish-packages.yml -f package=<pkg> -f registries=both -f dry_run=false
```

In the run's *Publish to npmjs.org* step expect `Authenticated via OIDC Trusted Publishing (provenance attached).` and **no** `::warning::` for that package; the package's npmjs page should then show provenance information for that version (exact UI wording per npmjs.com — [`npm audit signatures`][npm-prov] is the documented CLI check). The GitHub Packages leg of `registries=both` is independent and unchanged.

**What a manual dispatch does and does not prove.** A manual `publish-packages.yml` dispatch only proves *that* workflow's Trusted Publisher entry. It says nothing about the `tag-release.yml` entry, which is what the automatic release publish (`publish-npm`) authenticates as (if npm validates the calling workflow, as the troubleshooting guidance quoted above says). That entry is only proven by the **next real release run**: open the `publish-npm` job's *Publish to npmjs.org* step log and check, for every package, that the `::warning::OIDC publish of <pkg> failed — retrying with the legacy NPM_TOKEN fallback` line is **absent** and `Authenticated via OIDC Trusted Publishing` is present. While `NPM_TOKEN` still exists, a missing/misconfigured `tag-release.yml` entry will *not* fail the release — the package silently falls back to the token and the only signal is that warning — so do not skip this check, and do not start the cut-over checklist until a release run has come back warning-free.

### Cut-over checklist (retiring `NPM_TOKEN`)

Do these in order, only after **every** package in `ALL_PACKAGES` has published via OIDC with no fallback warning — and well before the ~January 2027 token cutoff:

1. On each package: **Settings → Publishing access → "Require two-factor authentication and disallow tokens"** (per [npm's docs][npm-tp] this affects only traditional token auth; Trusted Publishers keep working). Do this only after a *release* run (not just a manual dispatch) has published every package via OIDC with no fallback warning.
2. Revoke the Automation token on npmjs.com and delete the `NPM_TOKEN` GitHub secret.
3. In a follow-up PR remove the now-dead plumbing: the `NPM_TOKEN` secret declaration in `publish-packages.yml`, the `secrets:` block in `tag-release.yml`'s `publish-npm`, `NPM_FALLBACK_TOKEN` in the npmjs publish step, and the fallback branch in `scripts/publish-package.sh`.

### Sources

Retrieved while writing this section (npm's pages change; re-check before relying on a detail):

- [npm-tp]: https://docs.npmjs.com/trusted-publishers/ — requirements (npm 11.5.1+, Node 22.14.0+), "up to 10 trusted publishers" per package, 2-day expiry of an unvalidated configuration, "Allowed actions" and the Sep 2026 default, "disallow tokens" setting, npm trying OIDC before token fallback.
- [npm-trust]: https://docs.npmjs.com/cli/v11/commands/npm-trust/ — `npm trust` requires npm 11.15.0+ and account 2FA; states the registry currently supports one configuration per package.
- [npm-prov]: https://docs.npmjs.com/generating-provenance-statements/ — `repository` must match (case-sensitive); provenance generated automatically under Trusted Publishing; `npm audit signatures`.
- [npm-doc-1755]: https://github.com/npm/documentation/issues/1755 — quotes npm's troubleshooting text on `workflow_call`/`workflow_dispatch` validating the calling workflow's name; the thread is an open question about reusable workflows, not an npm statement of record.
- [setup-node-1551]: https://github.com/actions/setup-node/issues/1551 and [setup-node-1477]: https://github.com/actions/setup-node/pull/1477 — the disputed `registry-url` / placeholder-token interaction with OIDC.

[npm-tp]: https://docs.npmjs.com/trusted-publishers/
[npm-trust]: https://docs.npmjs.com/cli/v11/commands/npm-trust/
[npm-prov]: https://docs.npmjs.com/generating-provenance-statements/
[npm-doc-1755]: https://github.com/npm/documentation/issues/1755
[setup-node-1551]: https://github.com/actions/setup-node/issues/1551
[setup-node-1477]: https://github.com/actions/setup-node/pull/1477

## The mechanism

In-repo, nothing is renamed. Packages keep their `@imajin/*` names and `workspace:*` references. `scripts/prepare-npm-publish.mjs` rewrites `@imajin/` → `@ima-jin/` in both the manifest and the emitted code at publish time, and strips `private: true` in the publish copy. The published identity is `@ima-jin/*` (the scope we own on npm — `@imajin` is not ours); the codebase's import surface stays `@imajin/*`. Do not rename in-repo or rewrite imports to match the published scope.

## Structural checklist for a publishable package

- `private: true` (safety net — without it, a stray `npm publish` run directly in the package directory would attempt to publish under the wrong, unowned `@imajin/*` scope)
- `description`, `license`, `repository` (with the `git+https://github.com/ima-jin/imajin-ai.git` form and a `directory` pointing at the package)
- `type: module` — **only if the actual build output uses ESM syntax**. See the `tokens` exception below.
- A `tsup` build → `dist/`, with `main`/`types`/`exports` all pointing at `dist/`, not `src/`. Raw-TS `exports: "./src/index.ts"` is not publishable and forces downstream `transpilePackages` hacks.
- `files` allowlist (typically `["dist/", "src/"]`)
- `prepublishOnly: "npm run build"`

## Choosing ESM-only vs dual ESM+CJS — verify, don't assume

Default to **ESM-only** (`exports: { types, import }`). Only add a `require` condition (dual format, `tsup format: ['esm', 'cjs']`) when **every** runtime dependency genuinely supports `require()`. A CJS build that can't actually resolve at runtime is a lying manifest — worse than shipping none — and throws `ERR_REQUIRE_ESM` downstream.

**Don't guess from a dependency's major version or reputation.** Check the actual installed package's `package.json` `exports` field:

```bash
cat node_modules/.pnpm/<pkg>@<version>/node_modules/<pkg>/package.json
```

Look for a real `require` condition (or a `default` condition that points at a genuine CJS file — some packages, like `postgres`, use `default` as the de facto CJS fallback instead of an explicit `require` key). A package with only `import`/`default` pointing at ESM output, or `"type": "module"` with no `exports` map at all (Node then throws `ERR_REQUIRE_ESM` for `require()`), is ESM-only regardless of its major version. Two same-family packages can differ across major versions — e.g. `jose@5` ships a genuine CJS build, `jose@6` dropped CJS entirely.

## The `'use client'` single-bundle gotcha (the big one)

`tsup` bundles each entry point into **one output file**. Next.js's RSC "use client" detection operates on the bundled *file*, not on individual exports. If a package's main entry re-exports both a client component (with its own `'use client'` directive) and a plain server-safe utility, bundling merges them into one file — and the directive doesn't survive being merged into the middle of that file. Every Server Component that imports *only* the plain utility gets flagged with:

> You're importing a component that needs useState. It only works in a Client Component but none of its parents are marked with "use client".

This bit both `packages/fair` (its `FairAccordion`/`FairEditor` React components were re-exported from the same `index.ts` as pure attribution/crypto logic — broke `apps/coffee` and `apps/learn`) and `packages/ui` (`themeInitScript`/`buildServiceMetadata`/etc. were re-exported alongside every client component — every app's root `app/layout.tsx` would have broken).

**Fix:** split the client-only exports into their own entry (`src/react.ts` for `fair`, published as `@imajin/fair/react`; `src/server.ts` for `ui`'s plain utilities, published as `@imajin/ui/server`), add it to `tsup.config.ts`'s `entry` array, and add a matching subpath to `package.json` `exports`. Update in-repo consumers to import from the correct subpath. **The only way this surfaces is a real `pnpm build` across the whole workspace** — `pnpm typecheck` and `vitest` won't catch it, since neither runs Next's RSC compiler. Always run a full `pnpm build` before opening a PR that switches a React-adjacent package to `dist`-based exports.

## Tarball leakage

`files` entries support npm's negation globs (`"!src/__tests__/**"`), and `npm pack`/`npm publish` honor them **even though** `scripts/prepare-npm-publish.mjs`'s copy step is not glob-aware (it naively copies whatever's listed, so a negation entry just becomes a harmless "not found" warning during the copy — the exclusion happens later, in npm's own packing pass). Check for this whenever a package doesn't follow the sibling-`tests/`-directory convention: `packages/fair` nests two test files inside `src/__tests__/`, which would have shipped in the tarball without the negation entries.

Also check for hand-written files living outside `dist/`/`src/` that a subpath export points at — `packages/config`'s `./next-headers` subpath points at a root-level `next-headers.cjs` that isn't under `src/`, and it was missing from `files` entirely. In-repo resolution never noticed (workspace symlinks ignore `files`), but the file would have silently 404'd for real npm consumers.

Dry-run every new tarball shape before merging:

```bash
node scripts/prepare-npm-publish.mjs packages/<pkg> .tmp-<pkg>
cat .tmp-<pkg>/package.json
Get-ChildItem .tmp-<pkg> -Recurse   # (or find .tmp-<pkg> -type f)
Remove-Item -Recurse -Force .tmp-<pkg>
```

## `peerDependenciesMeta` keys need rewriting too

`prepare-npm-publish.mjs` rewrites `dependencies`/`peerDependencies` keys from `@imajin/*` to `@ima-jin/*`, but originally did not touch `peerDependenciesMeta`. A package with `peerDependencies: { "@imajin/auth": "workspace:*" }` and `peerDependenciesMeta: { "@imajin/auth": { optional: true } }` (see `packages/pay`) ended up with a rewritten `peerDependencies` key but a stale `peerDependenciesMeta` key — the `optional: true` marker silently stopped matching anything. Fixed in the script (it now rewrites both), but worth knowing if you're touching that script again.

## Wire the package into shared CI config whenever it flips to `dist`

Two files outside the package need updating whenever a package's `main`/`types`/`exports` moves from `src/` to `dist/`, because plenty of other packages/apps import it by bare specifier and neither typecheck nor tests build packages first:

- **`.github/workflows/ci.yml`**, `Build workspace type dependencies` step (`lint-and-typecheck` job) — add `--filter @imajin/<pkg>` so `pnpm typecheck` can resolve the package's `dist/*.d.ts` from every consumer. `packages/vault-core` needs `packages/cid` built first for the same reason (declaration cross-reference) — order matters when there's an inter-package dependency.
- **`vitest.config.ts`**, `resolve.alias` — add `{ find: '@imajin/<pkg>', replacement: resolve(__dirname, 'packages/<pkg>/src/index.ts') }` so the `Test` job (which never runs a build step) resolves straight to source instead of a `dist/` that doesn't exist yet. If the package has a subpath entry (e.g. `@imajin/fair/react`, `@imajin/ui/server`), alias the **subpath first** — vite's alias matching treats a bare string `find` as a prefix match, so a broader `@imajin/fair` entry listed before `@imajin/fair/react` will match and mis-resolve the subpath too.

Skip both for packages with zero in-repo consumers (e.g. `auth-client`) — there's nothing to typecheck or test against.

**`publish-packages.yml` has an analogous gap that hasn't been hit yet:** its own `Build packages` step is a plain shell loop, not `pnpm --filter` with pnpm's topological ordering, so dispatching a single package that depends on another normalized package (not yet an issue for anything in this set beyond `cid`/`vault-core`, which the workflow already special-cases) could fail the same way. Worth checking if a new inter-package dependency shows up in a future normalization.

## SonarCloud's "coverage on new code" gate

Adding a new source file (a barrel/re-export entry like `src/react.ts` or `src/server.ts`) with zero test coverage fails the PR's SonarCloud quality gate (`0.0% Coverage on New Code`, required ≥ 80%) even when nothing else about the change is risky. Add a small, real test that imports the new entry and asserts the exports are the right shape (`toBeTypeOf('function')`, etc.) — don't reach for a coverage-exclusion config change to route around it.

## Scoping: not everything in `packages/*` should be published

The epic's principle is "any runtime library that is — or plausibly will be — consumed across a repo boundary." In practice, most of the remaining `packages/*` (`bus`, `chat`, `dfos`, `email`, `emit`, `notify`, `trust-graph`) depend directly on `@imajin/db` or other server-internal packages (`onboard` is also an exception — see below) — they're implementation modules of the running services, not general-purpose libraries. An external consumer couldn't use them meaningfully without this repo's Postgres schema and internal wiring. Don't normalize these just to complete a checklist; wait for an actual external consumer need, the same way `db`/`cid`/`vault-core` were driven by `imajin-cli`/`fixready`/`karaoke` and `fair` by real `.fair`-consumption plans.

`media` is the exception to its former spot on that list: it has no `@imajin/*` dependencies at all (only `react`), and registered apps extracted from the monorepo (e.g. `market`, #2637) need `resolveMediaRef`/`resolveAssetUrl` from a published SDK rather than a drifting local copy, so it is now in the `publish-packages.yml` `package` choices and `ALL_PACKAGES`. It is not in `SDK_PACKAGES` (the `packages-v*` tag set).

`onboard` is the second exception: it is a standalone React component (`OnboardGate`) with only `react`/`react-dom` peers and no `@imajin/*` dependencies, and `market` needs it from a published SDK rather than a local copy that will drift (#2645), so it is published as `@ima-jin/onboard`, is in the `publish-packages.yml` `package` choices and `ALL_PACKAGES`, and is likewise not in `SDK_PACKAGES`.

`auth` and `logger` used to be on this don't-publish list for the same DB-coupling reason. They no longer are: `auth` had its DB access removed behind an internal kernel route (#1992), and `logger`'s DB-backed sink was split out to the optional `@imajin/logger/db` subpath (#2143) so the package root has zero `@imajin/db` in its dependency graph. That was the actual external-consumer trigger — #1981's registered-app extraction (starting with `dykil`, #1985) needs `auth`/`config`/`logger`/`ui` as a real out-of-repo SDK (#1982) — so both are now part of `ALL_PACKAGES` and the only packages the `packages-v*` tag path publishes.

`fair`'s `dependencies` used to list `@imajin/money` as a `workspace:*` entry, but the only thing `fair` actually needs from it is the `Money` **type** (`import type { Money } from '@imajin/money'` in `src/types.ts`) — there is no runtime import. Since `money` itself is not in `ALL_PACKAGES`, that entry would have made every `@ima-jin/fair` install (and therefore `@ima-jin/ui`, which depends on `fair`) require an unpublished package. First pass moved it to `devDependencies`, but that still left a problem one layer down: `tsup`'s `dts` step re-emits the *type* into `fair`'s own `.d.ts` as `import("@ima-jin/money").Money` regardless of which `package.json` field the source import came from, so the published `@ima-jin/fair` `.d.ts` would still reference an unpublished package — breaking typecheck for any consumer without `skipLibCheck: true` (caught in review on #1982's PR). The actual fix: inline the `Money` shape (`{ amount: number, currency: string }`) directly in `fair/src/types.ts` instead of importing it, and drop the `@imajin/money` devDependency entirely — `fair` never used anything from `@imajin/money` beyond that one type. The same "is anything actually shipped or built against this?" question applied to `config`'s `@imajin/tokens` dependency: it was only ever referenced by `packages/config/tailwind.config.js`, a file outside the package's `files` allowlist, outside its `tsconfig.json` `include`, and not referenced by a single consumer in the repo — genuinely dead, so the devDependency was removed outright rather than kept around.
