# Changelog

All notable changes to `@ima-jin/auth` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to the version already committed in `package.json` —
see [`docs/packages/PUBLISHING.md`](../../docs/packages/PUBLISHING.md) for how
that version is cut and published (lockstep with the rest of the workspace,
via the Release workflow, never a hand-edited per-package bump).

## [Unreleased]

Tracking changes since the last `packages-v*` publish. Add an entry here
alongside any user-visible change to this package, at or before the release
PR that bumps its version.

## [0.8.2] - Pending first publish

First version slated for publication to GitHub Packages as `@ima-jin/auth`
(#1982). No `packages-v*` tag has been pushed yet as of this writing — once
one is, this section's heading should be updated to reflect the actual
publish date.

### Included

- DID-based identity signing/verification (Ed25519), session and app-token
  middleware, scope grants, and identity tier checks.
- `resolve-db` split into its own `@ima-jin/auth/resolve-db` subpath so the
  root entry point never drags a static `drizzle-orm` import into consumers
  that don't need it (#1982, PR #2304).
- DB-free by default (#1992) — credential resolution goes through an
  internal kernel route rather than a direct database connection.
