# @ima-jin/logger

Structured logging for Imajin services, built on [pino](https://getpino.io).

## Install

```bash
npm install @ima-jin/logger
```

## Usage

```ts
import { createLogger, withLogger } from '@ima-jin/logger';

const logger = createLogger({ service: 'my-app' });
logger.info({ path: '/health' }, 'health check ok');
```

## Default transport: stdout

The package root (`@ima-jin/logger`) only ever writes to **stdout**. It has
zero dependency on `@ima-jin/db` (or any database driver) — installing it
does not pull in Postgres, `drizzle-orm`, or any other DB client.

For apps extracted out of the imajin-ai monorepo and run under pm2 (or any
other process manager that captures stdout), this is the whole story: pm2
captures stdout/stderr to its own log files, so there is nothing further to
configure.

## Optional: DB-backed request/app log sink (`@ima-jin/logger/db`)

If a service wants request or app logs persisted to Postgres in addition to
stdout, it can opt in with a side-effect import of the `/db` subpath, which
registers an additional log sink:

```ts
import '@ima-jin/logger/db';
```

In a Next.js app this belongs in `instrumentation.ts`'s `register()`:

```ts
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('@ima-jin/logger/db');
  }
}
```

`@ima-jin/logger/db` is the **only** module in this package that imports
`@ima-jin/db`. `@ima-jin/db` is declared as an **optional peer dependency** —
it is never installed or loaded unless a consumer explicitly imports the
`/db` subpath. This keeps the base `@ima-jin/logger` install (and its whole
dependency graph) free of any database driver, which matters for apps that
only need `createLogger`/`withLogger` and should not have to carry Postgres
along for the ride.

## Part of Imajin

[Imajin](https://imajin.ai) — sovereign technology infrastructure. Open source.
