# PR Checklist

Not every item applies to every PR. Scan the categories — check only what's relevant to your change.

## Schema / Database
- [ ] Migration generated via `drizzle-kit generate` from the app directory (never hand-written SQL)
- [ ] Migration has `→ statement-breakpoint` between each SQL statement
- [ ] Snapshot JSON exists alongside migration SQL + journal entry
- [ ] Backfill included if adding a column/table that needs existing data

## Dependencies
- [ ] New imports have matching entries in the consuming package's `package.json` (don't rely on pnpm hoisting)
- [ ] `pnpm install` from clean state works

## Cross-Service
- [ ] `.env.example` updated in every affected app
- [ ] `AUTH_INTERNAL_API_KEY` added if new service calls auth internally
- [ ] Service URLs added to `.env.local` on dev + prod for any new service-to-service calls
- [ ] `docs/ENVIRONMENTS.md` updated if new port/domain/schema

## API Routes
- [ ] `export const dynamic = 'force-dynamic'` on routes that touch the database
- [ ] CORS headers wired (OPTIONS handler + corsHeaders)
- [ ] Auth gated appropriately (requireAuth / optionalAuth / requireGraphMember)

## UI
- [ ] Provider chain verified (ToastProvider, SessionProvider, etc. in app layout)
- [ ] Existing components reused — search before writing new ones
- [ ] Mobile-responsive (no horizontal overflow, touch targets adequate)

## General
- [ ] Commit message follows convention: `type(scope): description (#issue)`
- [ ] No empty `catch {}` blocks — at minimum `console.error`
- [ ] No hardcoded service URLs — all from env vars
