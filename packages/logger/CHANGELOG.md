# Changelog

All notable changes to `@ima-jin/logger` will be documented in this file.

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

First version slated for publication to GitHub Packages as `@ima-jin/logger`
(#1982). No `packages-v*` tag has been pushed yet as of this writing — once
one is, this section's heading should be updated to reflect the actual
publish date.

### Included

- Structured logging (`pino`) with a **stdout-only default** — the package
  root has zero dependency on `@imajin/db`, so an extracted app needs no
  database configuration to log (see `packages/logger/README.md`).
- Optional DB-backed request/app log sink split into its own
  `@ima-jin/logger/db` subpath (#2143) — an explicit opt-in, not a default.
