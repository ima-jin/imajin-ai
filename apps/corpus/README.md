# @imajin/corpus

Per-DID corpus indexing and BM25 search service — an internal daemon (port 8003 in production), not a subdomain web app.

## What this is

Runs inside this monorepo today. Whether it's a kernel rail or a third-party app under the [registered-app contract](https://github.com/ima-jin/imajin-ai/issues/1981) hasn't been decided yet — #1981 explicitly calls this out as undecided, deferring to #1726. Until that's resolved, treat it as internal infrastructure rather than a registered app.

## Run it

```bash
pnpm --filter @imajin/corpus dev
```

See the [root README](../../README.md) for the kernel/app boundary.
