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
