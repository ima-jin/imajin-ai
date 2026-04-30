# CLAUDE.md — AI Assistant Guide for imajin-ai

## What this is

Reference implementation of the MJN Protocol — a sovereign identity and payments platform.
Monorepo: 1 kernel (9 domains) + 6 federated apps, all self-hosted.

## Documentation — load as needed

- [docs/DEVELOPER.md](docs/DEVELOPER.md) — read when setting up, debugging builds, or working with database/migrations/env vars
- [docs/ENVIRONMENTS.md](docs/ENVIRONMENTS.md) — read when working with ports, domains, or database names
- [docs/PR-CHECKLIST.md](docs/PR-CHECKLIST.md) — read before submitting a PR
- [docs/DEBT.md](docs/DEBT.md) — read when considering refactors, to check if the debt is already tracked
- [docs/MIGRATIONS.md](docs/MIGRATIONS.md) — read when changing database schemas
- [DESIGN.md](DESIGN.md) — read when working on UI or frontend components
- [docs/rfcs/](docs/rfcs/) — read when working on protocol-level features
- [docs/proposals/](docs/proposals/) — read when working on proposed or in-progress features

## Architecture

```
apps/
  kernel/     — Core platform (auth, identity, pay, profile, chat, media, notify, registry, connections)
  events/     — Event creation and ticketing
  coffee/     — Tip jar / support pages
  dykil/      — Surveys and polls
  links/      — Curated link collections
  learn/      — Courses and lessons
  market/     — Marketplace (alpha)

packages/     — Shared libraries (@imajin/auth, @imajin/db, @imajin/ui, etc.)
```

## Dev setup (quick version)

Full instructions in [docs/DEVELOPER.md](docs/DEVELOPER.md). The short version:

```bash
pnpm install
cp apps/kernel/.env.example apps/kernel/.env.local  # edit DATABASE_URL
pnpm dev                                             # starts all apps
```

## Key conventions

- **Database:** Single Postgres database, each service owns a named schema (auth, profile, chat, etc.). Tables are NOT in `public`.
- **Env vars:** Kernel uses `node --env-file=.env.local`. Next.js apps use built-in `.env` loading. Root-level scripts (db:migrate, db:reset) do NOT load .env files — you must `export DATABASE_URL` in your shell.
- **basePath:** Apps served behind a reverse proxy use Next.js `basePath`. Events uses `/events` (so locally: `localhost:3006/events`). Check each app's `next.config.js`.
- **Ports:** Dev `3xxx`, prod `7xxx`. Core: `x000–x099`, imajin apps: `x100–x199`, client apps: `x400–x499`.
- **Migrations:** Always use `drizzle-kit generate`, never `drizzle-kit push`. Never hand-write SQL. See [docs/DEVELOPER.md](docs/DEVELOPER.md#migration-discipline).
- **IDs:** Prefix + timestamp + random pattern (e.g. `crs_m1abc123`).
- **Auth pattern:** Every service calls kernel's auth service. See `src/lib/auth.ts` in any app.
- **Dependencies:** Dynamic imports must be declared in `package.json`. Don't rely on pnpm hoisting.
