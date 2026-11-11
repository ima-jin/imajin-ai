# Migration ownership

Active root SQL belongs only to the kernel. App schemas and data belong to their
independently deployed app repositories, even when they share a Postgres server.
A kernel migration cannot create, read, alter or backfill an app schema. Use the
owning service's public API for runtime access.

## Sources of truth

- `ownership.json` maps schema objects to an owner and their creation filename.
  It retains app-owned objects as well as kernel objects; presence in this map
  does not authorize kernel SQL against them.
- `kernel-baseline.json` fixes the generated baseline, cut and archive checksums.
  Active root SQL initializes the kernel baseline plus post-cut migrations.
- `archive/pre-kernel-baseline/` holds immutable migration records, not active
  migrations. App-origin filenames in the ownership map resolve into this archive.
- `ownership-gaps.json` and `cross-schema-allowlist.json` retain the runtime audit
  inventory. Entries naming the absent `apps/events` tree do not establish a
  current monorepo call site or authority to restore one.

See [BASELINE.md](BASELINE.md) for adoption, backups and restore gates, and
[the migration guide](../docs/MIGRATIONS.md) for runner usage. Neither a source
prune nor a baseline change authorizes deleting app data or rewriting the ledger.

## Owners and schemas

The parser recognizes `kernel`, `coffee`, `dykil`, `links`, `learn`, `events`,
`market`, `broker-agent` and `corpus`. The named app schemas belong to the
corresponding app; the kernel owns its service schemas such as `auth`, `chat`,
`connections`, `inference`, `kernel`, `media`, `notify`, `pay`, `profile`,
`registry`, `usage` and `www`. Read `ownership.json` for the complete object map,
not a hand-maintained table count.

Events, coffee, dykil, links, learn and market run from their `ima-jin/<app>`
repositories. Broker-agent has no Postgres schema here; corpus uses its own
SQLite store. Their inclusion in the parser's owner vocabulary is not a reason
to create tables for them in the kernel database.

## New migration rule

Every new migration declares `-- owner: kernel` near the top, uses idempotent,
schema-qualified SQL and registers new persistent objects in `ownership.json` in
the same change. Choose a free number above the active migration range, without
moving the baseline cut. Do not edit applied SQL or archived files.

`scripts/check-migration-ownership.mjs` compares changed migrations against
`origin/main` and validates declared owner and object ownership. Active baseline
mode also scans every active root file for non-kernel schemas, regardless of
header or shared-file allowlists. New external-schema references, schema DDL and
literal search paths are prohibited. Dynamic SQL still needs review: these
scanners are static heuristics, not a PostgreSQL parser.

Archived history is checksum-protected. A same-name move can only establish an
archive while activating a baseline against matching merge-base bytes; an active
baseline does not permit archive additions, edits or removal. Do not use an
allowlist entry as permission to import app history into active SQL.

Run the checks from the repository root:

```bash
bash scripts/check-schema-migration-sync.sh origin/main
bash scripts/check-migrations.sh
node scripts/check-migration-ownership.mjs
```

The ownership guard accepts `MIGRATION_OWNERSHIP_BASE_REF` for another base,
`CI_GUARD_WORKDIR` for a scratch root, and `GIT_BIN` for an absolute git binary
when it is not in the guard's known locations. Test the runner twice against an
isolated scratch database; retain each ledger row on the second run.

## Map maintenance

`scripts/lib/migration-ownership-parser.mjs` replays archived creation history
plus post-cut SQL, not the generated baseline, to retain object origins. It
tracks supported creation, alteration, rename and drop forms. The generator's
no-flag output is for review; do not blindly replace the committed map, which
also contains external-schema policy and explanatory metadata.

`scripts/__tests__/ownership-map.test.mjs` compares committed object ownership
with replay and checks audit-artifact consistency. A numeric inventory copied
into this guide would drift independently; use those artifacts instead.

## Runtime cross-schema query guard

`scripts/ci-guard-cross-schema-reads.mjs` scans source under `apps/<app>` for
foreign raw-SQL references and Drizzle schema declarations. Kernel source is
exempt from this app scanner because it legitimately owns several kernel service
schemas, not because the kernel may query app-owned tables.

`cross-schema-allowlist.json` is an exact `(file, schema, table)` ratchet, not a
namespace exemption. A new foreign table reference fails. Migrate a real call
site to the owner's API and remove its obsolete entry together with the matching
gap record; do not expand the allowlist to make CI pass. The guard's `--list`
mode reports detected current call sites. Retained audit metadata alone is not
proof that the named source still exists.

## Runner modes and retained shared records

`scripts/migrate.mjs --owner <owner>` filters by ownership. Shared files are
included for `kernel`, and for another owner only with `--include-shared`.
This compatibility filter does not transfer schema ownership, activate archived
SQL or provide a standalone app baseline. The active kernel baseline contains no
app schemas. Fresh standalone app setup follows that app's own migration runner.

The map's shared-migration allowlist records multi-owner seed/data operations in
the archive. It is not an escape hatch around the active kernel-only rule.
Existing databases adopt the baseline under the runbook's checks; they are not
reset or reconstructed by deleting migration rows.
