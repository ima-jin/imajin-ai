# Migration Ownership Map

Phase 1 of #1991. Every table/view/type/function created anywhere in
`migrations/` lives in exactly one Postgres schema, and every schema is
assigned to exactly one owner. This document explains the rule, how the
map was derived, and lists every gap the derivation surfaced. The machine-
readable map is `migrations/ownership.json`; `scripts/check-migration-ownership.mjs`
enforces it in CI (see [Rule](#rule) below).

**What phase 1 is not:** it does not move, rename, or squash any migration,
and it does not fix any of the cross-owner reads/writes listed in
[Gaps](#gaps). Those are deliberately deferred — see the PR description for
#1991.

## Owners

`kernel | coffee | dykil | links | learn | events | market | broker-agent | corpus`

Every schema in `migrations/` maps to exactly one of these:

| Schema | Owner |
|---|---|
| `coffee` | coffee |
| `dykil` | dykil |
| `events` | events |
| `learn` | learn |
| `links` | links |
| `market` | market |
| `auth`, `chat`, `connections`, `consent_requests`, `github`, `inference`, `kernel`, `media`, `money`, `notify`, `operator`, `pay`, `profile`, `registry`, `relay`, `usage`, `www` | kernel |

`broker-agent` and `corpus` own zero tables in `migrations/`: broker-agent
is a Telegram bot with no `@imajin/db` dependency (it authenticates via a
self-minted app-service token and talks to the kernel over HTTP only), and
corpus is a standalone Express service with its own `better-sqlite3` file,
not Postgres. Neither has a schema to own here — noted so their absence from
`ownership.json` doesn't read as an oversight.

## How the map was derived

`scripts/generate-migration-ownership.mjs` (built on the same parser the CI
guard uses, `scripts/lib/migration-ownership-parser.mjs`) replays every file
in `migrations/` in application order and tracks `CREATE TABLE`,
`CREATE [OR REPLACE] FUNCTION`, `DROP TABLE`, and `ALTER TABLE ... RENAME TO`
(the only DDL forms actually present in this repo's 131 migration files,
confirmed by grepping for `CREATE VIEW`, `CREATE TYPE ... AS ENUM`, and
`CREATE MATERIALIZED VIEW` — none exist today; the parser still recognizes
them so a future migration that adds one is registered, not silently
ignored). A `DROP TABLE` removes the entry; a `RENAME TO` carries the
original `firstMigration` forward under the new name. This is why
`ownership.json` has no entries for `drizzle.*` (dropped in
`0003_drop_drizzle_tracking.sql`, and in fact never created by a migration
file — it predates the plain-SQL runner), `profile.connection_requests` /
`profile.did_migrations` (created in `0001_seed.sql`, dropped in `0003`),
`events.ticket_registrations` (created in `0001_seed.sql` /
`0015_ticket_registrations.sql`, dropped in `0027_drop_ticket_registrations.sql`),
or the `CREATE TEMP TABLE folder_dedup_map` in `0028_folders_unique_constraint.sql`
(a temp table dropped in the same file). The map reflects live schema, not
migration-file history.

Owner inference is schema-based: every table/function created in
`migrations/` is schema-qualified (verified — no unqualified/`public`-schema
persistent tables exist), so the schema name itself is the ownership
signal per the table above. This was cross-checked against
`packages/*/tests` and `apps/*/drizzle`: only `apps/events/drizzle` has a
Drizzle schema-introspection artifact, and per the #1983 audit it's
`schemaFilter`-cosmetic (drizzle-kit introspection output, not an ownership
declaration), so it added no signal beyond the schema qualifier already
used. No table name required resolving ownership by grepping app code
instead of by schema — see [Gaps](#gaps) for why this doesn't mean the
current code respects those boundaries.

**Counts** (155 tables, 2 functions, 0 views, 0 types):

| Owner | Tables |
|---|---|
| kernel | 132 |
| events | 8 |
| learn | 5 |
| links | 3 |
| market | 3 |
| coffee | 2 |
| dykil | 2 |

Full detail: `migrations/ownership.json`.

## Rule

An app's migrations may only create, alter, drop, or rename tables/views/
types/functions in its own schema. Touching another owner's schema from a
migration is a contract violation — the runtime equivalent (an app reading
or writing another app's tables directly instead of calling its API) is
exactly what caused the gaps below, and phase 1 exists to stop the DDL side
of that from getting worse while the runtime side is fixed separately.

### Header convention

Every **new** migration file must declare its owner as the first `--`
comment matching this pattern, anywhere in the file (by convention, right
after the filename comment at the top):

```sql
-- 0132_something.sql
-- owner: events
```

`scripts/check-migration-ownership.mjs` reads this header for every file
changed or added in a PR (`git diff origin/main...HEAD -- migrations/`):

- A **new** file with no `-- owner:` header fails the build.
- A file's declared owner must match what `ownership.json` says about every
  table/view/type/function the file's statements touch. Touching a table
  registered to a different owner fails the build.
- A **new** table/view/type/function must be added to `ownership.json` in
  the same PR — the guard fails if the map wasn't updated, so it can never
  silently drift out of date again.
- Pre-existing migration files this repo already shipped without a header
  are **grandfathered**: the guard only inspects files a PR actually
  changes, and a pre-existing file that's merely touched (not newly added)
  without a header is not retroactively required to add one — migrations
  are immutable, so rewriting history to add headers is out of scope here.

Wired into CI as `pnpm check:migration-ownership`, a step in the
`lint-and-typecheck` job in `.github/workflows/ci.yml`.

## Gaps

Ownership assignment above was unambiguous for every table (all names are
schema-qualified, and every schema maps to exactly one owner) — so there are
**zero UNRESOLVED entries** in `ownership.json`.

The real gap is not in *assigning* ownership, it's that several apps
already violate it at the code level, reading or writing tables outside
their own schema via raw SQL instead of going through the kernel's HTTP
API. These are the same findings as the #1983 audit's kernel-side gaps
6–9 (renumbered here to the specific tables involved), reproduced here
because deliverable 1 requires this list to live with the ownership map,
not just on the audit issue:

1. **`coffee`, `learn`, `market`, `events`** all read `relay.relay_config`
   (kernel-owned) directly via raw SQL to get the node DID, instead of a
   public `GET /registry/api/node/self`-style endpoint. 4 independent
   re-implementations of the same read (audit gap #8).
2. **`coffee`, `learn`, `market`** all read `profile.forest_config`
   (kernel-owned) directly, even though `profile.yaml` already documents
   `/api/forest/{groupDid}/config` and `/config/public` — the audit flags
   this as likely just unmigrated call sites rather than a missing route
   (audit gap #9).
3. **`learn`, `market`** read `profile.profiles` (kernel-owned) directly
   instead of through a profile API.
4. **`events`** is by far the heaviest violator — raw SQL against
   `auth.identities`, `auth.credentials`, `auth.onboard_tokens` (including
   `INSERT`), `connections.pod_members` / `connections.connections`
   (including `INSERT`), `profile.profiles` (including `UPDATE`),
   `relay.relay_config`, `chat.conversations_v2` (`UPDATE`), and
   `pay.transactions` (`JOIN`) — 11 distinct kernel-owned tables touched
   across ~15 files. Notably `events` also re-implements kernel's
   hard-eligibility tier-upgrade logic with a direct
   `UPDATE auth.identities` (audit gap #7) instead of calling an API kernel
   doesn't yet expose.
5. **`packages/auth`** (imported by every app) itself runs raw SQL against
   `auth.credentials`, `auth.identities`, `profile.profiles` from
   `credentials.ts` — so the DB-layer coupling isn't purely an app habit,
   it's partly baked into the shared library every app depends on (audit
   gap #6, "no batched identity/email resolution endpoint").

None of these are fixed here — out of scope for phase 1 per the issue.
They're listed so phase-1's CI guard has a documented, honest baseline: the
guard only prevents *new* cross-owner migrations; it does not (and is not
meant to) catch existing runtime cross-schema queries. That would need a
lint/static-analysis rule over application source, not a migration-file
guard, and is a candidate for a later phase.

## Deferred (explicitly out of scope for phase 1)

Per the issue decision (2026-09-09): baseline squash of the 131 existing
migration files into a clean per-schema baseline, and splitting
`migrations/` into per-repo/per-app migration directories, are both
deferred. `links` was the recommended first mover for a future per-repo
migration split (0 entanglement per the #1983 audit — no internal imports,
no DB couplings, no internal routes), but no such split happens in this
phase.

## For the migration runner

See `docs/MIGRATIONS.md` for the `scripts/migrate.mjs` quick reference; it
now links here for the ownership rule.
