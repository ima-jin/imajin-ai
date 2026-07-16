# .machine — machine-readable artifact layer

Terse specs derived from verbose human docs (GitHub issues/PRs/RFCs), for
agentic dev orchestrators (Warp, coder agents, CI) to ingest cheaply.

**Why:** the human-canonical version (the issue body) is verbose on purpose —
review, reasoning, provenance. Agents don't need the argument, only the spec,
and pay input-token cost on every ingest. This layer is the ~5–6× smaller
version they read instead.

## Convention

- One file per artifact: `.machine/<issue-or-pr-number>.md`.
- **Human doc is canonical.** `.machine/<n>.md` is *derived from* it, never the
  source of truth. Edit the issue; regenerate the machine file.
- Every file ends with provenance:
  - `source: <url>` — the canonical human artifact
  - `derived-from: sha256:<hash>` — sha256 of the exact source body it was
    generated from.
- **Drift check:** if `sha256(current source body) != derived-from`, the
  machine file is stale → regenerate. (Same honest-record move as the rest of
  the platform: the summary is trustworthy because you can verify what it came
  from.)

## Reader contract (orchestrators)

For issue/PR N: read `.machine/N.md` if present; else fall back to the body.

## Relation to llms.txt

This is `llms.txt` taken per-artifact and made verifiable. `llms.txt` /
`llms-full.txt` = repo-wide LLM map; `.machine/` = per-issue terse spec with a
derivation hash. Same instinct (cheap machine layer beside human docs), finer
grain, plus provenance.

## Status

Reference example only (`1327.md`), hand-generated. Generator + drift-check +
orchestrator wiring = follow-up spike (see the epic that references this).
