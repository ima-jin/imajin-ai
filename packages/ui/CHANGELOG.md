# Changelog

All notable changes to `@ima-jin/ui` will be documented in this file.

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

First version slated for publication to GitHub Packages as `@ima-jin/ui`
(#1982). No `packages-v*` tag has been pushed yet as of this writing — once
one is, this section's heading should be updated to reflect the actual
publish date.

### Included

- Shared UI components for Imajin apps — NavBar, identity management, app
  launcher, theming, and common patterns.
- Plain server-safe utilities (`themeInitScript`, `buildServiceMetadata`,
  etc.) split into their own `@ima-jin/ui/server` entry, away from
  client-component exports, to avoid Next.js RSC `'use client'` boundary
  bugs when a consumer bundles both from one entry (#1982, PR #2304; see
  `docs/npm-publishing.md`'s "`'use client'` single-bundle gotcha").
- `@ima-jin/fair` (peer of this package's editor/accordion exports) inlines
  its own `Money` type instead of depending on unpublished `@imajin/money`.
