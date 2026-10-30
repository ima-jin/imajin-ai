# PR Checklist

Not every item applies to every PR. Scan the categories — check only what's relevant to your change.

## Schema changes
- [ ] Kernel schema edits (including `apps/kernel/src/db/schemas/*` and `packages/db/src/**`) have the matching `migrations/NNNN_*.sql` required by the schema guard
- [ ] Idempotent SQL preferred (`IF NOT EXISTS`, `IF EXISTS`)
- [ ] Exception only via `migration-not-required: <reason>` in commit body

## Schema / Database
- [ ] Post-baseline migration is above the fixed cut and latest active number, declares `-- owner: kernel` and uses schema-qualified idempotent SQL; archived SQL/ledger rows are unchanged
- [ ] Drizzle-generated scaffolding is moved to root `migrations/` and adapted as described in [MIGRATIONS.md](MIGRATIONS.md); the root runner does not discover an app-local Drizzle journal
- [ ] `bash scripts/check-schema-migration-sync.sh origin/main` and migration/ownership checks pass; app-owned migrations stay in the app's repo
- [ ] Backfill included if adding a column/table that needs existing data

## Dependencies
- [ ] New imports have matching entries in the consuming package's `package.json` (don't rely on pnpm hoisting)
- [ ] `pnpm install` from clean state works

## Cross-Service
- [ ] `.env.example` updated in every affected app
- [ ] `AUTH_INTERNAL_API_KEY` (verify-delegation/grants-introspect) added if new service calls auth internally. `ATTESTATION_INTERNAL_API_KEY` (attestation forwarding) is vault-only (#2245, env fallback removed in #2353) — do NOT add it as a new `.env.example` entry or read it from `process.env`; a new consumer needs a grant via `scripts/grant-attestation-internal-api-key.ts` instead, same as corpus
- [ ] Service URLs added to `.env.local` on dev + prod for any new service-to-service calls
- [ ] `docs/ENVIRONMENTS.md` updated if new port/domain/schema
- [ ] Source-owner corpus grants and OAuth refs are checked, never a node GitHub-token fallback; see [corpus](../apps/corpus/README.md)

## API Routes
- [ ] `export const dynamic = 'force-dynamic'` on routes that touch the database
- [ ] CORS headers wired (OPTIONS handler + corsHeaders)
- [ ] Auth gated appropriately (requireAuth / optionalAuth / requireGraphMember)
- [ ] Route/spec changes are reflected in agent-readable `llms.txt`/`llms-full.txt`; internal/dev routes are distinguished from public access
- [ ] Private legal-entity/bank records use their dedicated release/custody helpers, not generic media or vault reads

## UI
- [ ] Provider chain verified (ToastProvider, SessionProvider, etc. in app layout)
- [ ] Existing components reused — search before writing new ones
- [ ] Mobile-responsive (no horizontal overflow, touch targets adequate)

## General
- [ ] Commit message follows convention: `type(scope): description (#issue)`
- [ ] No empty `catch {}` blocks — at minimum `console.error`
- [ ] No hardcoded service URLs — all from env vars
