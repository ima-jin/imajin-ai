# Publishing & consuming the Imajin SDK packages

This is the consumer-facing guide for the four packages that make up the
out-of-repo SDK surface for [#1981](https://github.com/ima-jin/imajin-ai/issues/1981)
(kernel/app split) and [#1982](https://github.com/ima-jin/imajin-ai/issues/1982)
(SDK publish):

- `@imajin/auth` → published as `@ima-jin/auth`
- `@imajin/config` → published as `@ima-jin/config`
- `@imajin/logger` → published as `@ima-jin/logger`
- `@imajin/ui` → published as `@ima-jin/ui`

For the internal mechanics of the publish pipeline (registries, the
`@imajin/*` → `@ima-jin/*` scope rewrite, tarball-shape gotchas, etc.), see
[`docs/npm-publishing.md`](../npm-publishing.md). This doc only covers: how a
maintainer ships a new version of these four, and how an out-of-repo app
consumes them.

## Why `@ima-jin/*`, not `@imajin/*`

The workspace packages are named `@imajin/*`, but `@imajin` is not a scope
this org owns on npm or GitHub Packages — the org is `ima-jin` (with a
hyphen). `scripts/prepare-npm-publish.mjs` rewrites the scope from
`@imajin/*` to `@ima-jin/*` in the manifest and emitted code at publish time.
**Install `@ima-jin/auth`, not `@imajin/auth`.** The rule from #1982 still
holds either way: consume it as a real published, versioned package — never
`workspace:*`, never a path into the monorepo.

## Maintainer: bump, tag, publish

`auth`/`config`/`logger`/`ui` do **not** get an independent, hand-edited
version bump. Every `package.json` version in this repo — root, every
`apps/*`, every `packages/*`, these four included — is bumped only in
lockstep, by the Release workflow (`docs/npm-publishing.md`'s "Cutting a
release" section, `AGENTS.md`'s "Versioning" section, #2285). A PR that
hand-edits just these four packages' versions is indistinguishable, to
`scripts/ci-guard-version-bump.mjs`, from any other unauthorized version
bump — it fails unless the head commit message starts with `release:`, the
one shape of commit the Release workflow itself produces. There is
deliberately no second, competing bump path here.

1. Cut a normal release: `gh workflow run release.yml -f bump=minor` (or
   `patch`). This bumps root **and every workspace package**, including the
   four SDK packages, to the same new `X.Y.Z` and opens a `release: vX.Y.Z`
   PR into `main`.
2. Merge that PR like any other reviewed PR — see `docs/npm-publishing.md`
   for the full pipeline (it also tags the repo's own `vX.Y.Z` build-version
   tag and rolls through `deploy-prod.yml`; that tag is unrelated to the
   `packages-v*` tag below).
3. Once merged, tag `main` with the SDK-publish tag and push it:
   ```bash
   git tag packages-v1.2.3
   git push origin packages-v1.2.3
   ```
   The tag's own version string is just a human-readable label for the
   release — it doesn't need to match `X.Y.Z` from step 1, since a
   `packages-v*` tag can be pushed at any commit where the four packages'
   already-lockstepped versions are the ones you mean to ship. In practice,
   push it right after the release PR from step 1 merges, so the label matches.
4. Pushing a `packages-v*` tag runs `.github/workflows/publish-packages.yml`
   with fixed parameters: it publishes exactly `auth`, `config`, `logger`, and
   `ui` to **GitHub Packages** (`npm.pkg.github.com`, `@ima-jin` scope) using
   the repo's built-in `GITHUB_TOKEN` — no other secret is read on this path
   (see `scripts/resolve-publish-params.mjs` and its tests for the exact
   branching this triggers).
5. Watch the **Publish Packages** workflow run in the Actions tab. Each
   package is built (`tsup`) and published from a freshly prepared
   `@ima-jin/*`-scoped copy (see `scripts/prepare-npm-publish.mjs`).
6. Optionally, run the **Smoke Test SDK Install** workflow (`workflow_dispatch`,
   `.github/workflows/smoke-sdk-install.yml`) against the version just
   published — see "Smoke-testing a published version" below.

Ad hoc/other-package publishes (the wider `cid`/`tokens`/`vault-core`/`db`/
`fair`/`pay`/`auth-client` set, or a re-publish to npmjs.org) still go through
`workflow_dispatch` on the same workflow. Like the tag path, `workflow_dispatch`
has no version-bump input either — every publish, for every package, ships
exactly the version already committed in that package's `package.json`. Bump
it in a normal PR, merge, *then* dispatch/tag.

## Consumer: installing from GitHub Packages

GitHub Packages requires npm/pnpm to know that the `@ima-jin` scope lives on
`npm.pkg.github.com`, and requires a token with at least `read:packages` to
install (GitHub Packages does not support fully anonymous installs, even for
public packages, the way npmjs.org does).

In the consuming app (**outside** this monorepo), add an `.npmrc`:

```ini
@ima-jin:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Then export the token as an environment variable in whatever shell or CI
environment runs `npm install` / `pnpm install` — **never commit a token**:

```bash
export GITHUB_PACKAGES_TOKEN="<your-personal-access-token>"   # a PAT (classic or fine-grained) with read:packages
```

Install as normal:

```bash
npm install @ima-jin/auth @ima-jin/config @ima-jin/logger @ima-jin/ui
```

`@imajin/ui` has a `next` peer dependency, and `@imajin/auth` does too — make
sure the consuming app's own Next.js version satisfies the peer range printed
by the install.

## What ships vs. what doesn't

- `@ima-jin/logger`'s package root has **zero** dependency on `@ima-jin/db` —
  see `packages/logger/README.md`. Default logging for an extracted app is
  **stdout**, which pm2 (or any other process manager) captures directly;
  there is nothing to configure. The DB-backed request/app log sink is an
  explicit opt-in via `@ima-jin/logger/db`.
- `@ima-jin/auth` has no direct database access either (#1992) — credential
  resolution goes through an internal kernel route.
- None of the four packages carry a `workspace:*` dependency that isn't
  itself resolvable from the registry: `@ima-jin/auth` and `@ima-jin/ui`
  depend on sibling packages that are published from the same pipeline
  (`config`, `logger`, `fair`), and `config`'s unused `tokens` dependency was
  removed outright (dead code, see `docs/npm-publishing.md`).
- `@ima-jin/fair`'s `Money` type is inlined in `fair/src/types.ts` rather
  than imported from `@imajin/money` — `money` isn't published, and a type
  re-export still shows up in the emitted `.d.ts` even when the source
  dependency lives in `devDependencies`, so "move it to devDependencies"
  alone isn't enough for a type-only cross-package reference. Inlining is.
- Each of the four packages carries a `CHANGELOG.md` (`packages/<name>/CHANGELOG.md`,
  [Keep a Changelog](https://keepachangelog.com/) format), which
  `scripts/prepare-npm-publish.mjs` copies straight into the published
  tarball alongside `README.md`. Add an entry there whenever a change to
  that package is user-visible, at or before the release PR that bumps its
  version (#1982).

## Smoke-testing a published version

`scripts/smoke-test-sdk-install.sh` proves the out-of-repo half of #1982's
acceptance criterion end-to-end: it creates a scratch directory **outside**
this repo, installs one or more `@ima-jin/*` packages from GitHub Packages
exactly the way a real external consumer would (via the `.npmrc` shape
documented above), and runs `scripts/smoke/sdk-mint-verify.mjs` against the
installed copy — mint a DID-signed, scope-carrying message with
`generateKeypair`/`createDID`/`sign`, then `verify` it, using only what the
installed package itself exports (no in-repo import, no `workspace:*`).

```bash
export GITHUB_PACKAGES_TOKEN="<a token with read:packages>"
bash scripts/smoke-test-sdk-install.sh auth@0.8.2 config@0.8.2
```

`.github/workflows/smoke-sdk-install.yml` runs the same script in CI —
`workflow_dispatch` (pick a version) or automatically after a **Publish
Packages** run that pushed to GitHub Packages succeeds — authenticated with
the repo's own `secrets.GITHUB_TOKEN` (`packages: read`), no new secret.

**What this does NOT cover:** actually minting a token from a live session
against `dev` (`POST {kernel}/auth/api/tokens/app`) requires a real,
authenticated first-party session cookie — there is no anonymous or
service-account path to that endpoint by design (see
`apps/kernel/app/auth/api/tokens/app/route.ts`), so an unattended CI job or
agent cannot obtain one. That full round-trip (mint against a real dev
session, then `verifyAppToken` from the installed package against
`AUTH_SERVICE_URL`) stays a manual, documented verification step for a human
with dev credentials; the automated smoke test instead exercises the
installed package's own sign/verify primitives, which is what's actually
reachable without a secret.

## Why the kernel (and `dykil`) still use `workspace:*`

`apps/kernel` and `apps/dykil` both still depend on `@imajin/auth`/`config`/
`logger`/`ui` via `workspace:*`, unchanged by this pipeline. That's
intentional, not an oversight:

- The kernel **is** where these packages' server-side counterparts and the
  routes they call (e.g. `/auth/api/tokens/app`) live — it makes no sense for
  the origin of an SDK to consume its own published copy of itself.
- `dykil` is the first app slated to actually consume the published SDK from
  outside the monorepo, but that extraction is
  [#1985](https://github.com/ima-jin/imajin-ai/issues/1985), which is still
  open and explicitly blocked on this issue (#1982) plus the registry
  (#1990) and audit (#1983) work. `apps/dykil` is still inside this repo as
  of this writing.
- Switching any in-repo consumer to a registry version today would force a
  publish-and-bump round trip for every single change to `auth`/`config`/
  `logger`/`ui` during ordinary development — exactly the workflow the
  monorepo (and `workspace:*`) exists to avoid. There is no non-monorepo
  consumer yet for it to trade that cost against.

Revisit this once `dykil` (or another app) actually moves to its own repo
under #1985 — that PR is the one that should flip its dependencies from
`workspace:*` to the published `@ima-jin/*` versions, not this one.
