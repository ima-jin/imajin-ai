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
same owner; an unfiltered kernel/MCP search includes the principal and the same
granted owner partitions as status, reusing its live grant checks. A revoked grant
fails closed, without partial results. Ranked hits are deduplicated with a global
result/evidence budget. Workspace writes must target the signed principal's own
partition, even when that principal has write authority for a group.
The remaining agent/principal proxy contract belongs to #3086. Membership-only
access remains #3100; this change does not mint grants or expand membership into
authority. Corpus-context remains opt-in and fail closed.

## One-shot owner migration

Deploy the kernel identity resolver before the daemon. Stop the daemon and any
other writers first; take the normal SQLite backup, including WAL checkpointing.
From the daemon's existing working directory and normal vault bootstrap
configuration, run once per legacy DID/source:

```bash
node --import tsx src/migrate-owners.ts "$LEGACY_DID" github:ima-jin/imajin-ai --expect-owner "$EXPECTED_ORG_DID"
```

The CLI resolves the destination through the kernel identity service using the
existing vault-backed internal credential. Its lookup is explicitly read-only:
it never creates an alias or identity, and a missing owner refuses the transfer.
The mandatory `--expect-owner` must equal the server-resolved owner before either
index is opened. This is a safety assertion, not a client-selected destination.
Missing identity/signing credentials fail closed. Use the daemon's normal
vault bootstrap configuration; never paste credentials into the command.
The transfer switches both databases to rollback journals for cross-file
transaction atomicity, then restores WAL. It copies threads, FTS rows, ref
snapshots, embedding chunks/vectors, source freshness, original signed
ingestion attestations and connector-reference/source-event history. It never
deletes rows, regenerates embeddings or rewrites historical signatures.

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
scoped to the resolved source-owner DID. Re-load the same source to select a replacement.

For every load/sync/crawl, the kernel's internal corpus transport checks the
current `github:read` grant and repository disclosure allowlist, resolves the
selected source-owner OAuth credential through the kernel vault, and forwards it in memory
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

The caller's corpus grant is checked before credential lookup. Stored connector
refs are read from the resolved owner's status partition, and the forwarded
`X-Corpus-Credential-Ref` names only that owner's slot. A missing or revoked group
connector never falls back to the caller's personal connector.

### Removed connector slots (v0.8.28)

Removing a non-primary GitHub slot retains its removed registry row, signed
history and the source's exact `github:<slot>` binding. `/auth/corpus` shows
**Connection removed** with last-success metadata; sync returns 410 without a
provider call or fallback. Re-load the source to choose a replacement explicitly.
Removing the selected slot never silently selects primary. Primary removal is
blocked (409); use Disconnect. The owner/admin confirmation lists source
dependencies for that owner and slot; unavailable dependency metadata blocks
confirmation. Delegated removal requires the owner to re-issue directly.
See [#3157](https://github.com/ima-jin/imajin-ai/pull/3157) and `/connections/api/spec`.
