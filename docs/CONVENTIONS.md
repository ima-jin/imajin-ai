# Documentation Conventions

This document defines the frontmatter convention for all content in `docs/articles/` and `docs/rfcs/`.

## Frontmatter Schema

Every markdown file must begin with a YAML frontmatter block:

```yaml
---
title: string                    # required — human-readable title
type: essay | rfc | adr          # required — content type
status: draft | shipped | superseded   # optional, default 'draft'
rev: number                      # essays only, optional — revision number
date: YYYY-MM-DD                 # optional — publication or creation date
author: string                   # optional — comma-separated authors
slug: string                     # optional, auto-derived from filename
topics: [list of strings]        # optional — lowercase-hyphenated tags
refs:
  rfcs: [list of numbers]        # optional — referenced RFC numbers
  issues: [list of numbers]      # optional — referenced GitHub issues
  prs: [list of numbers]         # optional — referenced GitHub PRs
  packages: [list of strings]    # optional — referenced npm packages
  essays: [list of slugs]        # optional — referenced essay slugs
  external:                      # optional — external references
    - url: string
      title: string
---
```

## Field Details

### `title`
Human-readable title. For essays, this is the headline. For RFCs, it is the topic without the "RFC-NN:" prefix.

### `type`
- `essay` — Long-form writing in `docs/articles/`
- `rfc` — Request for Comments in `docs/rfcs/`
- `adr` — Architecture Decision Record (future use)

### `status`
- `draft` — Work in progress, not final
- `shipped` — Published, approved, or implemented
- `superseded` — Replaced by a newer document

For essays that were previously marked `POSTED`, use `shipped`.

### `rev`
Revision number for essays that go through multiple drafts (e.g., `rev: 5`). Extracted from legacy `status: "DRAFT — REV 5"` strings.

### `slug`
Auto-derived from the filename (without extension). Used for cross-referencing. Must be unique within its type.

### `topics`
Lowercase-hyphenated tags. Free-form — no enum. Common ones:

| Topic | Use for |
|-------|---------|
| `legibility` | Transparency, receipts, disclosure, visibility |
| `fair` | .fair protocol, attribution, manifests |
| `identity` | DIDs, portable identity, auth, SSO |
| `agents` | AI agents, Jin, workspace agents, presence |
| `dfos` | DFOS chain, attestations, proof of state |
| `settlement` | Payments, fees, tokens, MJN, economics |
| `governance` | Voting, decisions, trust graph, primitives |
| `events` | Ticketing, parties, venues, RSVPs |
| `federation` | Fediverse, ActivityPub, Bluesky, handle resolution |
| `sovereignty` | Sovereign data, self-hosting, privacy, ownership |

### `refs`
Cross-references to other artifacts. Use numbers for RFCs/issues/PRs, slugs for essays, full package names for packages.

## Validation

The `scripts/build-matrix.mjs` generator validates every file against this schema. Invalid frontmatter causes the build to fail with a clear error message.

## Generated Files

Running `pnpm docs:matrix` produces:

- `docs/MATRIX.md` — Topic-grouped table of all artifacts
- `docs/INDEX.md` — Flat alphabetical list of all artifacts
- `docs/.matrix.json` — Machine-readable graph (used by future tooling)

These files are auto-generated. Do not edit them by hand.
