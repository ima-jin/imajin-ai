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
`CREATE [OR REPLACE] FUNCTION`, `DROP TABLE`, `ALTER TABLE ... RENAME TO`,
and generic `ALTER TABLE` (e.g. `ADD COLUMN`, which the map builder ignores
but the CI guard treats as "touching" the table) (the only DDL forms
actually present in this repo's 131 migration files, confirmed by grepping
for `CREATE VIEW`, `CREATE TYPE ... AS ENUM`, and `CREATE MATERIALIZED
VIEW` — none exist today; the parser still recognizes them so a future
migration that adds one is registered, not silently ignored). A
`DROP TABLE` removes the entry; a `RENAME TO` carries the
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

### Environment variables

The guard (`scripts/check-migration-ownership.mjs`) reads two optional
environment variables; neither is set by CI today, since the defaults are
already correct for how `ci.yml` checks out a PR:

- `MIGRATION_OWNERSHIP_BASE_REF` — the git ref to diff `HEAD` against.
  Defaults to `origin/main`, which is what every PR in this repo targets, so
  CI never needs to set it. Override it for local runs against a different
  base branch, or in tests that diff between two commits in a scratch repo
  (see `scripts/__tests__/check-migration-ownership.test.mjs`).
- `GIT_BIN` — absolute path to the `git` binary. Defaults to the first of
  `/usr/bin/git`, `/usr/local/bin/git`, `/opt/homebrew/bin/git`, `/bin/git`
  that exists (git is resolved to an absolute path rather than found via
  `PATH` — SonarCloud S4036). Override only if `git` lives somewhere else
  entirely.

`CI_GUARD_WORKDIR` (repo root, defaults to two directories up from the
script) is the same override every other `scripts/ci-guard-*.mjs` in this
repo already supports, for the same reason: tests point it at a scratch
directory instead of the real checkout.

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

## Shared migrations (#1991 phase 2a)

A migration file is **shared** when its SQL — DDL or DML, see
`scripts/lib/migration-schema-scan.mjs` — references more than one owner's
schema. Three files in this repo are shared today:

| File | Owners touched | Why |
|---|---|---|
| `0001_seed.sql` | coffee, dykil, events, kernel, learn, links, market | the historical monolithic seed — creates every schema at once |
| `0025_backfill_survey_responses_for_orphan_registrations.sql` | dykil, events | backfills `dykil.survey_responses` by joining `events.ticket_registrations`/`events.tickets` |
| `0026_clone_shared_survey_responses_per_ticket.sql` | dykil, events | clones `dykil.survey_responses` rows keyed off `events.ticket_registrations` |

These are listed in `ownership.json`'s `sharedMigrationAllowlist`, which
serves two purposes:

1. **CI guard grandfathering.** `scripts/check-migration-ownership.mjs`
   now additionally fails a *newly added* migration that touches more than
   one owner's schema (DDL or DML), unless it's on this allowlist. The
   three files above predate the check; the allowlist is what keeps them
   from being retroactively flagged, and is also where a future genuinely-
   necessary cross-owner migration would be added as a deliberate,
   reviewed exception (see the guard's own header comment).
2. **Documentation.** `0025`/`0026` are a concrete, in-repo example of why
   `dykil` was *not* picked over `links` as the #1991 phase-2 first mover:
   despite scoring 0 entanglement in the #1983 *application-code* audit,
   `dykil`'s own migrations directly join and update `events` tables —
   entanglement the app-level audit couldn't see.

Note that this detection is broader than the per-table check earlier in
this document: `parseStatements` (the per-table check's parser) only
recognizes DDL, so it doesn't see `0025`/`0026` touching `events` at all
(they contain zero DDL, only `UPDATE`/`INSERT`/`JOIN`). The shared-file
scan exists precisely to catch that class of cross-owner reference too.

## Per-owner migration runner mode (#1991 phase 2a)

`scripts/migrate.mjs --owner <app>` filters the existing root
`migrations/` file list down to files owned solely by `<app>`, using the
same shared/single-owner classification described above. A shared file is
included automatically under `--owner kernel`; for any other `--owner`, it
only runs when `--include-shared` is also passed. No flags at all keeps
the original, unfiltered behavior byte-for-byte — this is strictly a
filter layered on top, not a replacement.

This does **not** give any owner true migration isolation today: every
owner's earliest tables (or, for `dykil`/`events`, some later ones too)
are created inside a shared file, so running e.g. `--owner links` alone
against a fresh database will apply nothing for `links` at all unless
`0001_seed.sql` also runs (as `kernel`, or via `--include-shared`). See
`migrations/BASELINE.md`'s "Per-app migration directories" section for why
that's a structural gate on real per-app migration directories, not just a
runner feature.

It also does not give owners *order* independence: `0025` (shared,
`dykil`/`events`) reads a column that `0008` (`dykil`-only) adds, so
running `--owner kernel --include-shared` against a fresh database before
`--owner dykil` has run fails outright on `0025` (a real SQL error, not a
skip — the transaction rolls back and nothing is marked applied). Running
`--owner dykil` and then retrying `--owner kernel --include-shared`
succeeds, because the retry is idempotent — see `scripts/migrate.mjs`'s
header comment for the full explanation and why the plain no-flag command
remains the right choice for bootstrapping a database from empty.

Tracking stays in the single, shared `public._migrations` table regardless
of mode. This was verified against a real Postgres instance, not just
argued: a fresh database migrated with the plain no-flag command, and a
fresh database migrated by running `--owner kernel/coffee/dykil/events/
learn/links/market --include-shared` in that sequence, produce
byte-identical `pg_dump --schema-only` output and the same 132-row
`public._migrations` count. See `scripts/migrate.mjs`'s header comment for
the full convergence argument.

## Deferred (explicitly out of scope for phase 1 and phase 2a)

Per the issue decision (2026-09-09): baseline squash of the 131 existing
migration files into a clean per-schema baseline, and splitting
`migrations/` into per-repo/per-app migration directories, are both
deferred. `links` was the recommended first mover for a future per-repo
migration split (0 entanglement per the #1983 audit — no internal imports,
no DB couplings, no internal routes), but no such split happens in this
phase.

Phase 2a (this round) intentionally does not lift that deferral: it adds a
`--owner` filter and a stricter CI guard over the *existing* root
`migrations/` directory, and ships `migrations/BASELINE.md` as a dry-run-
only plan. No migration file is moved, and no `apps/<app>/migrations/`
directory is created. See #1991's phase-2 pre-work comment for the full
blocker writeup (why `links`'s only migration, `0001_seed.sql`, can't be
moved without either editing an existing migration's SQL or duplicating
its DDL under a second filename).

## For the migration runner

See `docs/MIGRATIONS.md` for the `scripts/migrate.mjs` quick reference; it
now links here for the ownership rule and the per-owner filter mode.
