# CLAUDE.md

Read these before doing anything:

- `docs/guide/canonical-patterns.md` — **the one correct primitive for each seam (auth, settlement, .fair, checkout identity). Do NOT re-implement these inline. Extend with an option instead of forking.** This is the single highest-leverage file for keeping the codebase coherent.
- `docs/DEVELOPER.md` — quickstart, env setup, port map, conventions
- `docs/ENVIRONMENTS.md` — service URLs, ports, domains
- `docs/PR-CHECKLIST.md` — what every PR needs
- `README.md` — monorepo structure, apps and packages

## Key gotchas

- **Kernel has no basePath.** Userspace apps have basePaths matching their name (`/events`, `/market`, etc.). Kernel serves at `/`.
- **Env loading:** Scripts don't auto-load `.env` files. Kernel uses `--env-file=.env.local`. Next.js apps use built-in `.env` loading. Export `DATABASE_URL` in your shell for scripts.
- **`NEXT_PUBLIC_` vars are build-time.** They get inlined by Next.js at build, not runtime.
- **All migration DDL must be idempotent.** Use `IF NOT EXISTS` everywhere.
- **Never set `NODE_ENV` in the shell.** Scripts set it internally.
- **After pulling main, rebuild everything.** Stale `.next` builds cause phantom errors.
- **Shared packages must not depend upward.** Infrastructure packages have zero app dependencies.
## What this is

Reference implementation of the MJN Protocol: the six primitives and their rails.
The current workspace contains the kernel, broker-agent and corpus. Events,
coffee, dykil, learn, links and market are independently owned apps built on Imajin,
not workspace targets. Inventory and owned README links are generated in README.md.

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
  broker-agent/ — Internal Telegram agent surface
  corpus/     — Internal owner-DID retrieval daemon

packages/     — Workspace libraries (@imajin/*); published SDKs use @ima-jin/*
```

## Dev setup (quick version)

Full instructions in [docs/DEVELOPER.md](docs/DEVELOPER.md). The short version:

```bash
pnpm install
cp apps/kernel/.env.example apps/kernel/.env.local  # edit DATABASE_URL
pnpm --filter @imajin/kernel dev                      # starts only the kernel
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
## Release seams (v0.8.27 source)

- Legal entity: `getLegalEntity` enforces per-field release; bank details use
  `/auth/api/bank-details`, individual vault seals and retained immutable history.
  Generic media scopes and generic vault fetch do not disclose these records.
- SSH CA/signing: use the canonical vault primitives and `/vault/api/spec`.
  The reusable GitHub OIDC deploy action is documented in
  `docs/deploy/vault-ssh-deploy.md`; it does not authorize a live host rollout.
- Corpus sources resolve to the registry owner DID, not a source hash or caller.
  Check live owner grants before minting claims or selecting that owner's OAuth
  connector. No node-token or personal-connector fallback. Read `apps/corpus/README.md`.
- `@imajin/llm` uses AI SDK 5/provider SDK 2 and Zod 4. Tool contracts use
  `inputSchema`, and streamed tool arguments use `input`; do not copy SDK 4
  `parameters`/`args` examples into current consumers.
