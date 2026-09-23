# Publishing `packages/*` to npm

Reference notes from the npm-publish epic ([#1573](https://github.com/ima-jin/imajin-ai/issues/1573)). Read this before normalizing another package for publication — several of these were discovered the hard way (real build failures caught before merge, not theoretical).

## Cutting a release (tag is truth — #2285)

This repo's release version and the repo's npm-package versions (below) are two separate, unrelated concerns — this section is about the FORMER: the `vX.Y.Z` tag that decides what `scripts/build.sh` displays as the running build version and what `deploy-prod.yml` ships to production.

**Releases are cut ONLY through this three-workflow pipeline** — nobody creates a `vX.Y.Z` tag by hand, nobody pushes to `main` outside a normal PR, and no PR ever hand-edits a `package.json` `"version"` field (see the "Versioning" section of the root `AGENTS.md`). No step in this pipeline uses a bypass token or a PAT; every workflow authenticates with the default, ephemeral `secrets.GITHUB_TOKEN`, and the only human approval gate is `deploy-prod.yml`'s existing `production` GitHub Environment reviewer — the exact same gate every other prod deploy already goes through.

1. **[`release.yml`](../.github/workflows/release.yml)** — `workflow_dispatch` (`gh workflow run release.yml -f bump=minor|patch`, default `minor`, or the GitHub Actions UI), gated to `main`. It:
   - Reads the root `package.json` version as the single source of truth and bumps it by the chosen `minor`/`patch` type.
   - Writes that exact new version into **every** `package.json` in the workspace (root + every `apps/*`/`packages/*` manifest) via `scripts/bump-workspace-version.mjs` — true lockstep, all packages land on the same `X.Y.Z`, regardless of what they were at before. See that script's header comment for why this is a small dedicated Node script instead of the originally-proposed `pnpm -r version <bump>`: that command is a no-op on the pnpm version this repo pins (`pnpm@9.15.0`), and wouldn't produce lockstep even if it worked, given this repo's real per-package version divergence.
   - Commits to a new `release/vX.Y.Z` branch with message `release: vX.Y.Z` — that exact prefix is what lets the commit past `scripts/ci-guard-version-bump.mjs` (see below), the same guard that blocks every other PR from touching a version field.
   - Pushes that branch (never `main`) and opens a normal PR into `main` titled `release: vX.Y.Z`, then explicitly dispatches `ci.yml` against the branch so the PR's required status checks actually populate (a PR opened via the default `GITHUB_TOKEN` doesn't trigger other workflows' `pull_request` events, so without this the checks would sit pending forever — `workflow_dispatch` is exempt from that suppression, and GitHub matches required checks to a commit SHA regardless of which trigger produced them).
2. **A human reviews and merges the `release: vX.Y.Z` PR** exactly like any other PR — same branch protection, same required checks, no bypass.
3. **[`tag-release.yml`](../.github/workflows/tag-release.yml)** — runs on every push to `main`, but only acts when the real merged commit's message starts with `release: v` (read off `HEAD^2` when `main` is merged via GitHub's default "create a merge commit" strategy, the same technique `ci-guard-version-bump.mjs` uses — a merge commit's own generic "Merge pull request #N ..." message is not the release commit's message). When it matches, it creates the annotated tag `vX.Y.Z` at that commit, pushes the tag, and explicitly dispatches `deploy-prod.yml` against that tag (`gh workflow run deploy-prod.yml --ref vX.Y.Z -f ref=vX.Y.Z`) — needed because a tag pushed with the default `GITHUB_TOKEN` does NOT fire `deploy-prod.yml`'s own `push: tags: ['v*']` trigger (same GITHUB_TOKEN-suppression rule as above). Idempotent: skips tag creation if it already exists, and won't double-dispatch a deploy for a tag it already dispatched one for.
4. **`deploy-prod.yml` runs as normal**, held at its existing `environment: production` required-reviewer gate until a reviewer approves — unchanged by any of this.

`scripts/build.sh` derives `NEXT_PUBLIC_VERSION` from `git describe --tags --abbrev=0 --match 'v[0-9]*'` (#2287 — restricted to version-shaped tags so a future non-version tag can never hijack the footer; falling back to the root `package.json` version only on an untagged checkout, then `dev`) — see `packages/ui/src/BuildInfo.tsx` and `scripts/lib/build-version.sh`. As of this fix landing, the first Release run after merge is a `patch` bump: `v0.8.0` → `v0.8.1`.

### The CI guard that keeps this true (`scripts/ci-guard-version-bump.mjs`)

Runs as a step in `ci.yml`'s `CI Guards` job on every PR. It compares every `package.json` `"version"` field against `origin/main`; any difference fails the job UNLESS the PR's actual head commit message (read off `HEAD^2` on a pull_request's synthetic merge-commit checkout, so a generic "Merge ... into ..." message never masks it) starts with `release:`. See `scripts/__tests__/ci-guard-version-bump.test.mjs` for the passing/failing/release-exempt cases this covers.

## Two registries, one canonical

`.github/workflows/publish-packages.yml` publishes each selected package to **two** registries ([#1595](https://github.com/ima-jin/imajin-ai/issues/1595)):

- **npmjs.org — canonical.** The only install path. `imajin-cli`, `fixready`, and `karaoke` install `@ima-jin/*` from here anonymously, with no auth and no `.npmrc`. Authenticated with `secrets.NPM_TOKEN`.
- **`npm.pkg.github.com` — visibility only.** Its sole purpose is populating the `ima-jin/imajin-ai` → **Packages** sidebar, which GitHub renders only for packages actually hosted on GitHub Packages (the `repository` + `directory` fields give the npm→GitHub backlink on the npmjs page, but do nothing for the sidebar). Nothing installs from here. Authenticated with the ephemeral `GITHUB_TOKEN` — **never a PAT**; publishing from a workflow in this repo is also what auto-connects each package to the repo. Requires `packages: write` on the job.

Both publishes run from the same prepared tarball via `scripts/publish-package.sh <pkg> <registry-url> <dry-run>`, in separate steps so each registry's token is only in scope for its own step. npmjs goes first, so a GitHub Packages failure can never block the canonical publish.

### The `packages-v*` tag path (#1982)

Pushing a `packages-vX.Y.Z` tag runs the same job with fixed parameters instead of `workflow_dispatch` inputs: it always publishes exactly the four out-of-repo SDK packages (`auth`, `config`, `logger`, `ui`), to **GitHub Packages only**, using `GITHUB_TOKEN` — `NPM_TOKEN` is never read on that path. This is the path an extracted app (e.g. `dykil`, #1985) actually installs from; see `docs/packages/PUBLISHING.md` for the consumer-facing `.npmrc` setup. Bump the four packages' versions and merge that before pushing the tag — the tag-triggered run itself never bumps versions (`version_bump` is forced to `none`).

### The `registries` dispatch input

Defaults to `both`; `npmjs` and `github-packages` publish to just one. The single-registry options exist because **npm returns a 409 for a version that already exists**, which fails the whole step — so publishing a version that is already live on one registry but missing from the other (e.g. the original GitHub Packages backfill of `0.8.0`/`0.6.1`) requires skipping the registry that already has it. Reach for these when the two registries have drifted; otherwise leave it on `both`.

`.npmrc` note: `actions/setup-node` only writes auth for `registry.npmjs.org`, so `publish-package.sh` writes a throwaway project-level `.npmrc` into the temp publish dir for the GitHub Packages leg. The `${NODE_AUTH_TOKEN}` in it is single-quoted on purpose — npm expands it when reading the file, so no token value ever lands on disk, and npm never packs `.npmrc` into a tarball. Do not "fix" it into a real interpolation.

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

The epic's principle is "any runtime library that is — or plausibly will be — consumed across a repo boundary." In practice, most of the remaining `packages/*` (`bus`, `chat`, `dfos`, `email`, `emit`, `media`, `notify`, `onboard`, `trust-graph`) depend directly on `@imajin/db` or other server-internal packages — they're implementation modules of the running services, not general-purpose libraries. An external consumer couldn't use them meaningfully without this repo's Postgres schema and internal wiring. Don't normalize these just to complete a checklist; wait for an actual external consumer need, the same way `db`/`cid`/`vault-core` were driven by `imajin-cli`/`fixready`/`karaoke` and `fair` by real `.fair`-consumption plans.

`auth` and `logger` used to be on this don't-publish list for the same DB-coupling reason. They no longer are: `auth` had its DB access removed behind an internal kernel route (#1992), and `logger`'s DB-backed sink was split out to the optional `@imajin/logger/db` subpath (#2143) so the package root has zero `@imajin/db` in its dependency graph. That was the actual external-consumer trigger — #1981's registered-app extraction (starting with `dykil`, #1985) needs `auth`/`config`/`logger`/`ui` as a real out-of-repo SDK (#1982) — so both are now part of `ALL_PACKAGES` and the only packages the `packages-v*` tag path publishes.

`fair`'s `dependencies` used to list `@imajin/money` as a `workspace:*` entry, but the only thing `fair` actually needs from it is the `Money` **type** (`import type { Money } from '@imajin/money'` in `src/types.ts`) — there is no runtime import. Since `money` itself is not in `ALL_PACKAGES`, that entry would have made every `@ima-jin/fair` install (and therefore `@ima-jin/ui`, which depends on `fair`) require an unpublished package. First pass moved it to `devDependencies`, but that still left a problem one layer down: `tsup`'s `dts` step re-emits the *type* into `fair`'s own `.d.ts` as `import("@ima-jin/money").Money` regardless of which `package.json` field the source import came from, so the published `@ima-jin/fair` `.d.ts` would still reference an unpublished package — breaking typecheck for any consumer without `skipLibCheck: true` (caught in review on #1982's PR). The actual fix: inline the `Money` shape (`{ amount: number, currency: string }`) directly in `fair/src/types.ts` instead of importing it, and drop the `@imajin/money` devDependency entirely — `fair` never used anything from `@imajin/money` beyond that one type. The same "is anything actually shipped or built against this?" question applied to `config`'s `@imajin/tokens` dependency: it was only ever referenced by `packages/config/tailwind.config.js`, a file outside the package's `files` allowlist, outside its `tsconfig.json` `include`, and not referenced by a single consumer in the repo — genuinely dead, so the devDependency was removed outright rather than kept around.
