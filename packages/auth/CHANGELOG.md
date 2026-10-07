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

### Changed

- **Breaking:** `requireSessionOrAppToken` / `requireHardDIDOrAppToken` take
  `{ slug }` (the app's registry slug) instead of `{ aud }` (a host). The
  expected audience is `IMAJIN_APP_AUD` when set, else the slug; host-shaped
  audiences are rejected, and `verifyAppToken` refuses non-slug `aud` values.
  A Bearer token that fails verification now returns 401 instead of silently
  falling back to the session cookie (#2706).

### Added

- `resolveAppAudience`, `isAppAudienceSlug`, `APP_AUD_ENV` (#2706).

- `requireHardDIDOrAppToken` — `requireSessionOrAppToken` plus a hard-DID
  (non-soft tier) check, usable from registered apps authenticating with a
  scoped app token (#2640).
- Act-as (group DID) on scoped app tokens (#2639, #2644). `verifyAppToken` returns an optional
  `actingAs`, and `requireSessionOrAppToken` surfaces it as `auth.actingAs` on the `token` path
  (never on the `cookie` path). The kernel checks the user's group authority once at token mint and
  only for operator-approved apps, so there is no per-request re-check and token lifetimes are
  unchanged. Apps own records as `auth.actingAs ?? auth.did`.
- `validateActingAs` and the `ActingAsResult` type are exported (the existing group-permission gate,
  unchanged) so the kernel's token mint reuses it instead of adding a second authority check.
- `registry.app.act_as.updated` attestation type (operator act-as approval toggle).

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
