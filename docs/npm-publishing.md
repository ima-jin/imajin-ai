# Publishing packages to npm

The canonical external install scope is `@ima-jin/*` on npmjs.org. Workspace
imports remain `@imajin/*`; publication prepares a separate copy rather than
renaming the source tree. The publishable set is `ALL_PACKAGES` in
[the publish workflow](../.github/workflows/publish-packages.yml), not every
server-internal package under `packages/`.

## Cutting a release

Tags are the release source of truth. All workspace manifest versions move in
lockstep only through the reviewed Release workflow; feature changes never edit
version fields. Never create or push a release tag by hand, bypass branch
protection or deploy by pulling source on the production host.

1. An authorized operator dispatches `release.yml` on `main`, choosing patch or
   minor. It computes the next version from the latest reachable release tag,
   falling back to the root manifest only when no release tag exists.
2. The workflow uses `scripts/bump-workspace-version.mjs`, commits a
   `release: vX.Y.Z` change on its release branch and opens a normal PR into
   main. A scoped GitHub App installation token handles both push and PR creation;
   the native `pull_request` event starts CI.
3. A reviewer merges the release PR with its release commit message intact.
   `tag-release.yml` detects that release through merge history, tags the result
   and explicitly dispatches production deployment against the tag.
4. `deploy-prod.yml` still waits for the existing `production` Environment
   reviewer approval. Tag creation does not bypass that gate.
5. A separate `publish-npm` job calls the reusable publish workflow with
   `package: all`, `registries: npmjs` and the exact release tag. No manual
   publish step is needed for a release; npm publishing does not wait for the
   deployment approval.

Release close-out is automatic: a separate `close-out` job
creates the GitHub Release with generated notes and
moves open issues and PRs to the lowest open patch milestone in the same
major/minor series, then closes the released milestone. Existing Releases and
closed milestones are skipped; no next patch milestone means a warning with no close.
Close-out fails visibly without affecting tagging, the deploy dispatch or npm publish.

These procedures are operator actions, not tasks to run from an ordinary feature
agent session. Redeploying an existing ref uses the deploy workflow without
inventing a new version. See [deployment](../deploy/README.md).

## Release App configuration

Install the release App on `imajin-ai` only, granting **Contents: Read & write**
and **Pull requests: Read & write**. Set Actions variable `RELEASE_APP_ID` and
Actions secret `RELEASE_APP_PRIVATE_KEY` in the protected GitHub UI. Missing
configuration fails before checkout or branching without printing values.
Keep the repository's **Allow GitHub Actions to create and approve pull requests**
setting OFF. No PAT, bypass actor, manual release PR or CI dispatch workaround is
part of this contract.

Verify a real main-only release dispatch opens the expected bot-authored PR and
starts its checks through `pull_request`. Unit tests do not prove the installed
App, repository setting or live event chain.

## Publish mechanism and registries

`scripts/prepare-npm-publish.mjs` copies the package into a temporary publish
directory, rewrites `@imajin/` to `@ima-jin/` in manifests and emitted code, resolves
workspace references and strips the copy's private flag. Dependency and
`peerDependenciesMeta` keys must agree. Source manifests/imports remain unchanged.

The workflow can target npmjs, GitHub Packages or both. npmjs is the canonical
anonymous install path. GitHub Packages populates the repository Packages sidebar
and is not the canonical consumer registry. Its credential is the ephemeral
`GITHUB_TOKEN` with `packages: write`, never a PAT. Each registry gets its own
step and isolated auth configuration; npmjs runs first.

The `packages-v*` compatibility tag trigger selects `SDK_PACKAGES` and GitHub
Packages only. It has no version-bump step and is not the normal release path.
Do not hand-push tags or edit package versions to invoke it; use the reviewed
release and authorized workflow controls.

`scripts/npm-package-published.mjs` checks the target registry's packument before
publishing. A listed version is skipped; a missing package/version proceeds.
Auth errors, server errors, malformed data and network uncertainty fail closed.
Packages publish in dependency order and stop at the first failure. Re-running a
partially failed job resumes unpublished packages, not silent partial success.

An authorized backfill may dispatch `publish-packages.yml` for selected packages
and registries using the version already committed at its selected ref. Dry-run
validates packaging, not registry credentials or Trusted Publisher configuration.

## Trusted Publishing and provenance

The publish job uses `id-token: write` for npm Trusted Publishing and pins its
npm CLI in the workflow. It asserts a supported CLI floor before publishing;
consult that source and [npm's Trusted Publishing documentation](https://docs.npmjs.com/trusted-publishers/)
for current tooling requirements instead of copying a tool-version history here.

For each package, configure npm's GitHub Actions Trusted Publisher for
`ima-jin/imajin-ai`, with no Environment name for this publish job, and permit
the workflow's actual `npm publish` action. Automatic release publication is
called from `tag-release.yml`; manual backfills use `publish-packages.yml`.
Confirm reusable-workflow issuer matching and supported publisher count in npm's
current documentation/UI, then prove each intended path with a real publication.
A successful manual dispatch does not prove the automatic release path.

`scripts/publish-package.sh` tries OIDC with a throwaway npm config that has no
static auth token. npmjs publication uses public access and provenance. If that
attempt fails and the existing optional `NPM_TOKEN` fallback is configured, it
warns and retries once with an environment-reference config, never a literal
token on disk. Without fallback, the failure is visible. GitHub Packages does
not use npmjs OIDC or its provenance flag.

The publish copy needs a public repository URL matching the publishing repo;
the preparation script supplies missing metadata. Inspect the package's published
provenance and the real job log: expect `Authenticated via OIDC Trusted Publishing`
without a fallback warning. An already-published skip proves no auth path.
See [npm provenance](https://docs.npmjs.com/generating-provenance-statements/).

Retire the legacy token only after every publishable package has succeeded via
the automatic release's OIDC path with no fallback warning. The scope owner then
restricts token publishing, revokes the token, removes the Actions secret and
reviews removal of fallback plumbing separately. Do not remove fallback based
only on a dry-run or package-source test.

## Preparing a publishable package

The workflow pins npm and checks a minimum CLI of 11.5.1; npm Trusted Publishing
also requires a supported Node release (at least 22.14.0 in this setup). Read the
workflow's exact pin before changing it. Package-owner setup must permit direct
`npm publish`, not only staged publication. Validate a newly configured publisher
promptly: npm documents expiry after two days without its first successful publish.
The `npm trust` CLI requires a supported npm release and account-level 2FA;
verify the current UI/CLI publisher-count and reusable-workflow rules instead of
assuming that one manual backfill proves the release caller.

Keep `private: true` in source as a safety net. The publish copy, not an accidental
in-place `npm publish`, owns the public scoped identity. Provide description,
license, repository/directory metadata, a built entry point, declarations,
explicit exports and a `files` allowlist. Add a package to `ALL_PACKAGES` only
when an actual external consumer can use it without kernel-private wiring.

A dist-based package needs matching `main`, `types` and `exports`, a build into
`dist/`, and `prepublishOnly: "npm run build"`. Set `type: module` only for ESM
output. An export outside `src/` or `dist/`, such as a root CommonJS helper, must
also appear in `files`; workspace symlinks do not test tarball inclusion.
Packing honors negation globs even when the preparation copy step cannot expand
them. Inspect the prepared package and the packed list, not just copied files.

Each publish attempt uses isolated npm config. For GitHub Packages the temporary
project config contains an environment-variable reference to `NODE_AUTH_TOKEN`,
never expanded credential bytes. Do not rewrite it into a literal token.
OIDC failure may use the existing optional token fallback once, with a visible
warning; a dry run performs no OIDC exchange and proves no Trusted Publisher.
`scripts/ci-guard-version-bump.mjs` and `scripts/ci-guard-version-tag-sync.mjs`
enforce release-only manifest changes and tag/manifest alignment.

Choose ESM-only unless every runtime dependency genuinely supports require.
Inspect actual package exports and emitted files; a nominal CJS entry that loads
an ESM-only dependency is not working dual-format support. Declaration imports
must also resolve to published packages: moving a type-only dependency to dev
metadata does not stop the declaration builder from emitting its type reference.

## React and server entry points

Bundling client components and server-safe utilities through one barrel can
lose or misapply the `use client` boundary. Keep dedicated subpath entry points
such as fair's React entry and UI's server entry, with matching build inputs and
exports. A real consuming Next build is required: typechecking and unit tests do
not exercise the React Server Component compiler.

When a package changes from source to dist exports, include it and its prerequisite
builds in CI's workspace type-dependency step. Add source aliases in
`vitest.config.ts` for unbuilt test imports, listing specific subpaths before
broader package aliases. Validate both emitted entry points and consumer imports.

## Tarball and CI checks

Inspect the prepared manifest and an actual `npm pack --dry-run` file list.
Include root-level exported files as well as dist outputs; exclude nested tests,
fixtures, env files and credential-bearing config. Workspace symlinks can hide a
missing tarball file. npm's packing exclusions and the preparation script's copy
behavior are different stages and both need inspection.

Run the relevant package tests, declaration build and consumer build before a
publication change. New source entry points need real import/export coverage;
do not change Sonar exclusions or quality rules to hide missing coverage.
The release version guards reject feature version bumps and manifests behind
the latest release tag. Packaging changes do not authorize overriding those guards.
