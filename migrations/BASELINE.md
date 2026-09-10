# Kernel Baseline Squash — Dry-Run Plan (#1991 phase 3)

**Status: plan only. Nothing in this document has been executed.** Per the
2026-09-09 decision recorded on #1991 (see `OWNERSHIP.md`'s "Deferred"
section), the actual squash waits on deploy posture (#2060). This document
exists so the procedure is designed, reviewed, and ready before that gate
lifts — not to schedule when it happens.

## Why a squash at all

`migrations/` is 132 files deep, and `0001_seed.sql` alone creates all 155
tables across every owner (kernel: 132, events: 8, learn: 5, links: 3,
market: 3, coffee: 2, dykil: 2). Every fresh environment — a new dev box, a
CI ephemeral DB, a disaster-recovery restore — replays the *entire* build-
up/tear-down history to reach current schema, including tables that were
created and dropped again (e.g. `events.ticket_registrations`, dropped in
`0027_drop_ticket_registrations.sql`) and columns that were added and later
altered. A baseline squash replaces that replay, for kernel-owned schemas
only, with a single migration that is a direct dump of the schema *as it
exists today*.

This is explicitly **kernel-only**. App-owned tables (`coffee`, `dykil`,
`events`, `learn`, `links`, `market`) are out of scope for this document —
see "Per-app migration directories" below for why those are gated
separately and by a different mechanism.

## Preconditions (must all be true before this plan is executed)

1. **#2060 (deploy posture) resolved**, specifically: a build-stamp
   mechanism exists so "what migration head is prod actually running" is a
   query, not an assumption, and a documented, tested rollback path exists.
   Squashing history is irreversible in spirit (old migration files stop
   being replayable against a fresh DB) even though the squash migration
   itself can be reverted like any other.
2. **A recent, verified prod schema dump exists** and has been diffed
   against a fresh `migrate.mjs` run on an empty DB (the same proof
   technique used in phase 2's convergence check) to confirm the baseline
   candidate is byte-identical to what 131 migrations actually produce —
   not what they were *intended* to produce.
3. **No in-flight PR touches kernel-owned migrations.** A squash lands as
   one atomic commit; a kernel migration merging concurrently against the
   pre-squash file list would need to be re-numbered against the post-squash
   baseline.

## Procedure (dry run)

### 1. Generate the baseline candidate

```bash
# Against a DB that has every existing migration applied (dev, or a fresh
# DB with `node scripts/migrate.mjs` run to completion):
pg_dump --schema-only \
  --schema=auth --schema=chat --schema=connections --schema=consent_requests \
  --schema=github --schema=inference --schema=kernel --schema=media \
  --schema=money --schema=notify --schema=operator --schema=pay \
  --schema=profile --schema=registry --schema=relay --schema=usage --schema=www \
  --schema=public \
  --no-owner --no-privileges \
  "$DATABASE_URL" > /tmp/kernel_baseline_candidate.sql
```

`--schema=public` is included only for the `public._migrations` tracking
table's own definition, which must NOT be part of the baseline's managed
DDL (see step 4) — it's captured here only to diff against, not to ship.

The candidate needs manual cleanup before it's a real migration:
idempotency guards (`CREATE TABLE IF NOT EXISTS`, etc. — `pg_dump` output
is not idempotent by default), removal of `SET`/session-config lines
`pg_dump` emits, and removal of anything under `public` except as noted
above.

### 2. Prove it's equivalent, not just plausible

```bash
# Fresh DB A: apply the full 131-file history.
createdb imajin_baseline_check_a
DATABASE_URL=postgres://.../imajin_baseline_check_a node scripts/migrate.mjs

# Fresh DB B: apply only the cleaned-up baseline candidate.
createdb imajin_baseline_check_b
psql postgres://.../imajin_baseline_check_b -f /tmp/kernel_baseline_candidate_cleaned.sql

# Diff schema-only dumps of the kernel-owned schemas from both.
pg_dump --schema-only <kernel schema flags from step 1> --no-owner --no-privileges \
  postgres://.../imajin_baseline_check_a > /tmp/a.sql
pg_dump --schema-only <kernel schema flags from step 1> --no-owner --no-privileges \
  postgres://.../imajin_baseline_check_b > /tmp/b.sql
diff /tmp/a.sql /tmp/b.sql   # must be empty
```

An empty diff is the acceptance bar — same technique phase 2's PR uses to
prove the `--owner` filter changes nothing about final schema state.

### 3. Mark the baseline as already-applied on existing databases

Existing databases (prod, dev, any long-lived environment) must NOT
re-run the baseline's DDL — they already have this schema from the 131
individual migrations. The baseline migration ships alongside a one-time
backfill that inserts its own tracking row directly, without executing its
SQL body:

```sql
-- Run once, by hand, against every existing database BEFORE the baseline
-- migration file is ever picked up by scripts/migrate.mjs's normal loop:
INSERT INTO public._migrations (filename, checksum)
VALUES ('0001_kernel_baseline.sql', '<sha256 of the final baseline file content>')
ON CONFLICT (filename) DO NOTHING;
```

This mirrors how `scripts/seed-migrations.mjs` already handles "existing
DB, adopt tracking" per `docs/MIGRATIONS.md`'s "New Environment Setup"
section — same mechanism, applied to one specific new file instead of the
whole history.

### 4. Retire (do not delete) the old files

The 131 pre-baseline kernel-touching migration files move to
`migrations/archive/` (exact name TBD at execution time) rather than being
deleted — deleting them would break any environment that hasn't yet
recorded the baseline backfill row from step 3, since `scripts/migrate.mjs`
would then have no way to reach current schema from empty. They stop being
part of the active `migrations/` directory `scripts/migrate.mjs` scans, but
remain in git history and in the archive directory for audit purposes.

App-owned files interleaved in that same 131 (see `OWNERSHIP.md`'s Owners
table — every app's earliest tables are among them) are **not** archived
by this procedure; they stay live in `migrations/` exactly as today, since
they're outside this squash's scope.

### 5. Fresh nodes vs. prod

- **Fresh nodes** (new dev environments, new self-hosted deployments,
  ephemeral CI databases): `scripts/migrate.mjs` runs
  `0001_kernel_baseline.sql` like any other migration — one file, one
  transaction, full kernel schema, no 131-file replay.
- **Prod is re-baselined, never re-initialized.** Prod's existing database
  keeps its data; only its `public._migrations` bookkeeping changes (step
  3's backfill). The schema itself is untouched by the squash — the
  baseline file's DDL never executes against prod, by construction (its
  tracking row is inserted directly, not earned by running the file).

## Per-app migration directories — the other deferred half, and why it's a different kind of gate

The issue's Phase 2 acceptance also asked for at least one app (`links` or
`dykil`) to run its migrations from `apps/<app>/migrations/`. Phase 2's
pre-work (see the inventory comment on #1991) found this blocked by two
independent things, both still true as of this document:

1. **Policy**: explicitly deferred by the 2026-09-09 decision pending
   deploy posture (#2060) — same gate as the squash above.
2. **Structural**: `links`'s only migration touch, and most of every other
   app's, is `0001_seed.sql` — the same shared, immutable file this
   baseline squash also has to deal with. There is no standalone
   `links`-only (or `dykil`-only) file today to relocate.

These two problems compose in a specific way worth spelling out now, so
whoever picks this up next round doesn't have to re-derive it:

- **A move must be either a baseline squash, or empty-directory-from-now-
  on — never duplicated DDL.** Splitting `links`'s three `CREATE TABLE`
  statements out of `0001_seed.sql` into a new
  `apps/links/migrations/0001_links_seed.sql`, while leaving the originals
  in place, would mean the same DDL exists under two filenames with two
  checksums in `public._migrations`. That's not a relocation, it's a fork —
  both files are idempotent (`CREATE TABLE IF NOT EXISTS`), so nothing
  breaks *today*, but it silently defeats the ownership map's purpose
  (there's no longer one file of record for `links.pages`'s origin) and
  makes a future rename/alter ambiguous about which copy is authoritative.
- **Option A — squash-and-split together.** If a kernel baseline squash
  (this document) ever happens, doing an app's baseline squash in the same
  pass is the clean way to get `apps/<app>/migrations/0001_<app>_baseline.sql`
  as a real, standalone file: dump `<app>`'s schema at the cut, mark it
  applied on existing DBs exactly like step 3 above, and the *original*
  `0001_seed.sql` no longer needs to carry `<app>`'s tables at all once
  every app sharing it has either squashed or archived alongside it.
- **Option B — prospective-only, no squash.** Alternatively,
  `apps/<app>/migrations/` starts empty and only gains files for migrations
  authored from that point forward; `<app>`'s existing tables stay recorded
  as originating in root `0001_seed.sql` in `ownership.json` (already true
  today) permanently, or until a later squash. This avoids touching history
  at all but only partially satisfies "app runs its migrations from its own
  directory" — it's true prospectively, not retroactively.
- Whichever option is chosen, it happens **after** #2060 resolves, not
  before — the policy gate and the structural gate both have to clear.

No decision is made here between Option A and Option B; that's the design
call the #1991 phase-2 pre-work comment asked for and deferred to whoever
picks this back up once #2060 is resolved.
