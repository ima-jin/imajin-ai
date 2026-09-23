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

1. Bump the version(s) in the relevant `packages/<name>/package.json` — `auth`,
   `config`, `logger`, `ui` — and open a normal PR. `package.json` versions in
   `main` are the source of truth; the publish workflow itself never commits a
   version bump.
2. Once merged to `main`, tag it and push the tag:
   ```bash
   git tag packages-v1.2.3
   git push origin packages-v1.2.3
   ```
   The tag's own version string is just a human-readable label for the
   release — each package keeps its own independent version from its
   `package.json`; the tag doesn't need to match any single package's number.
3. Pushing a `packages-v*` tag runs `.github/workflows/publish-packages.yml`
   with fixed parameters: it publishes exactly `auth`, `config`, `logger`, and
   `ui` to **GitHub Packages** (`npm.pkg.github.com`, `@ima-jin` scope) using
   the repo's built-in `GITHUB_TOKEN` — no other secret is read on this path.
4. Watch the **Publish Packages** workflow run in the Actions tab. Each
   package is built (`tsup`) and published from a freshly prepared
   `@ima-jin/*`-scoped copy (see `scripts/prepare-npm-publish.mjs`).

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
