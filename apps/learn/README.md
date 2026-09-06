# @imajin/learn-service

Courses, lessons, learning progress.

## What this is

A third-party app under the [registered-app contract](https://github.com/ima-jin/imajin-ai/issues/1981) — not a kernel primitive. Extraction into its own repo behind scoped app-tokens is tracked in #1981; today it runs inside this monorepo and authenticates against the kernel directly.

## Run it

```bash
pnpm --filter @imajin/learn-service dev   # http://localhost:3103
```

See the [root README](../../README.md) for what the kernel provides and how apps register.
