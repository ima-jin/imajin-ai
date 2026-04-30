# CLAUDE.md

Read these before doing anything:

- `docs/DEVELOPER.md` — quickstart, env setup, port map, conventions
- `docs/ENVIRONMENTS.md` — service URLs, ports, domains
- `docs/PR-CHECKLIST.md` — what every PR needs
- `README.md` — monorepo structure, apps and packages

## Key gotchas

- **Kernel has no basePath.** Userspace apps have basePaths matching their name (`/events`, `/coffee`, etc.). Kernel serves at `/`.
- **Env loading:** Scripts don't auto-load `.env` files. Kernel uses `--env-file=.env.local`. Next.js apps use built-in `.env` loading. Export `DATABASE_URL` in your shell for scripts.
- **`NEXT_PUBLIC_` vars are build-time.** They get inlined by Next.js at build, not runtime.
- **All migration DDL must be idempotent.** Use `IF NOT EXISTS` everywhere.
- **Never set `NODE_ENV` in the shell.** Scripts set it internally.
- **After pulling main, rebuild everything.** Stale `.next` builds cause phantom errors.
- **Shared packages must not depend upward.** Infrastructure packages have zero app dependencies.
