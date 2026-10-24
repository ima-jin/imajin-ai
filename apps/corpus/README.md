# @imajin/corpus

Per-DID corpus indexing and BM25 search service — an internal daemon (port 8003 in production), not a subdomain web app.
GitHub source credentials belong in the kernel vault; source configuration carries references, never token values.

## What this is

Runs inside this monorepo today. Whether it's a kernel rail or a third-party app under the [registered-app contract](https://github.com/ima-jin/imajin-ai/issues/1981) hasn't been decided yet — #1981 explicitly calls this out as undecided, deferring to #1726. Until that's resolved, treat it as internal infrastructure rather than a registered app.

## Run it

```bash
pnpm --filter @imajin/corpus dev
```

See the [root README](../../README.md) for the kernel/app boundary.

## Source ownership (#3089)

`resolveCorpusDid(source)` keys GitHub repositories by their owner's group DID,
resolved through the existing identity registry alias `(github, org:<lowercase owner>)`.
Repositories in the same organization share that group partition. Workspace
sources remain in the principal's partition. DIDs are never configured or
hardcoded by source name. The identity service reuses an existing alias or creates
an unclaimed business-scoped soft group stub, with signed creation provenance.
Public registry requests cannot claim the reserved `github` namespace.

An existing organization identity must be bound to its canonical registry alias
before cutover; a handle match is not proof of source ownership. Creating a stub
does **not** create controllers, memberships, or grants. Normal organization
identity/controller provisioning and explicit owner-issued grants remain required.
The kernel checks `introspectGrant` for `corpus:read` / `corpus:write`, with both
delegator and audience bound to the resolved owner, before minting a claim for
that partition. The signed `onBehalfOf` retains the requesting principal.
The daemon rejects source/partition mismatches and read claims used for writes.

`/auth/corpus` discovers the principal's currently granted read partitions and
shows each source's actual `ownerDid`. A source-specific search resolves to the
same owner; an unfiltered search still targets its principal partition.
The agent/principal MCP proxy contract and broader org-first retrieval belong
to #3086. This change does not mint grants or expand membership into authority.
Corpus-context opt-in/fail-closed behavior and connector credential sourcing
(#3090) are unchanged.

## One-shot owner migration

Deploy the kernel identity resolver before the daemon. Stop the daemon and any
other writers first; take the normal SQLite backup, including WAL checkpointing.
From the daemon's existing working directory and normal vault bootstrap
configuration, run once per legacy DID/source:

```bash
node --env-file=.env.local --import tsx src/migrate-owners.ts "$LEGACY_DID" github:ima-jin/imajin-ai
```

The CLI resolves the destination through the kernel identity service using the
existing vault-backed internal credential. Missing identity/signing credentials
fail closed. No destination DID flag or environment override exists.
The transfer switches both databases to rollback journals for cross-file
transaction atomicity, then restores WAL. It copies threads, FTS rows, ref
snapshots, embedding chunks/vectors, source freshness and original signed
ingestion attestations. It never deletes rows, regenerates embeddings or
rewrites historical signatures.

Both partitions retain the same signed `corpus.owner.transferred` record,
binding source, old/new owner, thread count and a hash of the original thread
rows. The old partition becomes hidden from live search/status and refuses new
ingestion for that source. Repeating the command returns `moved: 0` without
changing rows or adding another attestation. A nonempty destination for that
source is refused rather than silently overwritten; reconcile through reviewed
work before retrying. Other sources in either partition remain untouched.

Before restarting writers, verify source search and status under the new
owner-issued grants. Local fixture verification is not evidence that production
data has been migrated.

## GitHub credentials

On `/auth/corpus`, choose an existing GitHub OAuth connector and enter
`owner/repo`. Connector lifecycle stays on `/auth/connectors`; this form has no
token input. Source configuration persists only `credentialRef: "github:<slot>"`,
scoped to the effective DID. Re-load the same source to select a replacement.

For every load/sync/crawl, the kernel's internal corpus transport checks the
current `github:read` grant and repository disclosure allowlist, resolves the
selected OAuth credential through the kernel vault, and forwards it in memory
on the authenticated kernel-to-corpus request. It is never included in the
request body, source config, status, or browser response. The adapter has no
environment, CLI-file, or PAT fallback. Keep this internal transport on a trusted
private network (or TLS), as for the existing vault fetch transport.

Missing/revoked credentials fail closed. Status exposes a safe per-source `error`
and preserves the last successful sync time, including for empty repositories.
Configuration and sync outcomes append signed records in each DID's SQLite
`corpus_source_events`; an unavailable corpus signing identity refuses the
operation. Existing sources need an explicit connector selection, not a migrated
node-wide token. Remove obsolete GitHub token env settings from deployments;
this change does not read or edit deployment secret files.
