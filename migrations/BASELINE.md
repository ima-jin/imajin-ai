# Kernel baseline squash (#2525, #1991 phase 3)

## Scope and merge hold
Kernel schemas: `auth`, `chat`, `connections`, `consent_requests`, `github`,
`inference`, `kernel`, `media`, `money`, `notify`, `operator`, `pay`, `profile`,
`registry`, `relay`, `usage`, `www`. App schemas/ledgers belong in app repos.
Fresh kernel init does not initialize coffee, dykil, events, learn, links or
market; existing app schemas/data are never dropped.

DECISION ruled a (Ryan, 2026-10-16 19:25): kernel migrations may merge before
squash; the final cut absorbs everything on main. The old no-in-flight gate
is superseded. #1991 and #2517 are closed. `kernel-baseline.json` records the
exact cut and checksums. Future migrations use numbers above its highest
historical number, not `0002`.

**Merge waits for Jin's post-release prod re-diff (#2865) and actual
dev-restore dry run.** Synthetic CI evidence does not claim a real dev backup
passed. No live environment was accessed. Requested train: v0.8.19; package
versions remain release-workflow controlled.

## Reproduce/finalize
Prerequisites: Linux, Docker, Python 3, Node 22, pnpm 9. No env files, real
database URL or credentials. Scratch PostgreSQL 16 is digest-pinned, tmpfs,
`--network none`, without mounts/published ports.

```bash
pnpm install --frozen-lockfile --ignore-scripts --filter imajin-ai
git fetch origin main
git rebase origin/main
python3 scripts/kernel-baseline.py generate
python3 scripts/kernel-baseline.py check
bash scripts/check-migrations.sh
node scripts/check-migration-ownership.mjs
bash scripts/seed-drift.test.sh
git diff --check
```

Run from the dedicated PR worktree. `generate` replays archived history plus
new root SQL except the baseline, in filename order/per-file transactions.
It generates the kernel-only dump/static seeds/manifest, then moves absorbed
files unchanged to `archive/pre-kernel-baseline/`. Commit/push after the final
rebase, and inspect main once more before readiness. `check` regenerates from
the archive and fails on byte drift; it never absorbs post-cut files.
Ordinary migration execution scans root SQL only. The complete mixed-owner
history is retained for audit/dependency-correct scratch replay, not app
migration authority.

DDL uses dependency-aware `pg_dump` ordering from the pinned image, without
owners/ACLs, patch-version comments or random psql restrict tokens. All other
DDL/session settings remain. Baseline-only and full-history kernel catalog
dumps and normalized static seed content must match. The required `public.pgcrypto`
extension is installed explicitly and its version/schema inventory is compared
separately; the public ledger itself is not baseline-managed DDL.

### Required seed rows (and only these)
All populated kernel tables on **empty-history replay** are inventoried;
undeclared nonempty seed targets stop generation. Copied rows:
- `auth.attestation_type_registry`: platform vocabulary/descriptions; type keys.
- `auth.identities`: only keyless public-client sentinel
  `did:imajin:claude-desktop` from 0053, not an operator/user/signing key.
- `kernel.bus_chain_configs`: default/scoped reactor config, emission schedules
  and reach chains; event-type/scope keys.
- `notify.templates`: disabled 0158 templates; scope keys.
- `registry.apps`: Claude OAuth adapter and historical first-party registrations
  with their final retirement state. Placeholder public keys are nonfunctional
  sentinels, not credential values. These are kernel registry data, not app tables.
- `usage.emitters`: platform internal inference-passthrough configuration.

Rows are JSON-key sorted, then table/content sorted. Bookkeeping
`created_at`/`updated_at` are fixed to `2000-01-01T00:00:00+00:00`. Chain/template
UUIDs use UUIDv5 URL namespace with `imajin:baseline:chain:{event_type}:{scope}`
and `imajin:baseline:template:{scope}` (`None` spells NULL scope).
Only fresh seed bookkeeping changes; definitions/defaults/business config do
not. Existing databases retain original IDs/timestamps/operator config.
No runtime credentials, grants, balances, users, node provisioning, logs or
app rows are copied.

## Runner safety
`node scripts/migrate.mjs` or `--owner kernel` takes advisory/ledger locks in
a transaction:
- Existing baseline row: verify SHA-256, never re-execute.
- Complete history: every archived filename/checksum must match, and kernel
  schemas must exist. Insert **only** the baseline ledger row, no DDL/seeds.
  All historical ledger rows remain untouched.
- Empty untracked database: apply baseline and record atomically.
- Partial/checksum-mismatched history, unknown ledger state or existing
  untracked kernel: stop; no force-adoption or reconstruction.

Afterward, only post-cut root SQL runs. The blind `seed-migrations.mjs` path
is disabled for this layout. Finish missing historical migrations using the
pre-cut release in a separately reviewed recovery operation; never delete
ledger rows to force a fresh init. Explicit environment `DATABASE_URL` takes
precedence over the legacy env-file fallback. Scratch copies no env files.
App `--owner` flags are legacy filtering, not app init; each app repository's
runner/APP_DB_SCHEMA owns that.

**Prod is re-baselined, never re-initialized.** Normal release deployment
adopts a complete ledger without DDL. This does not repair schema drift.

## Jin's actual dev-restore dry run (server hands only)
Jin supplies an already verified **custom-format** dev backup, including
`public._migrations` and app schemas, via the established backup procedure.
Backup acquisition is outside this runbook. Do not source/print env files,
put live URLs in commands, or run migration commands against dev/prod.
Use a server with Docker access and enough memory for the restore's tmpfs.

```bash
git fetch origin chore/2525-kernel-baseline
RESTORE_WORKTREE=$(mktemp -d /tmp/imajin-2525-worktree-XXXXXX)
git worktree add --detach "$RESTORE_WORKTREE" origin/chore/2525-kernel-baseline
cd "$RESTORE_WORKTREE"
git rev-parse HEAD
pnpm install --frozen-lockfile --ignore-scripts --filter imajin-ai
python3 scripts/kernel-baseline.py check
read -r -p 'Absolute path to verified custom-format dev backup: ' DEV_RESTORE_DUMP
test -f "$DEV_RESTORE_DUMP"
python3 scripts/kernel-baseline.py restore --dump "$DEV_RESTORE_DUMP"
```

The command restores the supplied file into a new network-isolated container
using `pg_restore --no-owner --no-privileges --exit-on-error`, then runs the
actual migration runner twice, with a localhost URL only inside that container.
It compares pre/post kernel DDL, kernel/app relation OIDs/relfilenodes,
representative row xmin, all non-ledger table data/sequence values, and every
historical ledger filename/checksum/timestamp. Exactly one baseline row must
exist. It does not deploy or modify the source DB/backup.

Expected final line:
`PASS: supplied restore adopted twice; catalog, object IDs, all data and historical ledger preserved`

Failure means stop and leave the PR unmerged. Attach only a sanitized error
and exact SHA to #2525, never backup contents/rows/credentials. Investigate
missing history/checksum errors; do not edit the ledger to bypass them.
Record successful command, exact SHA, backup provenance/time (not contents),
PostgreSQL version and PASS result in #2525. Jin separately records the
post-release #2865 prod re-diff. These operator results satisfy the real
dev-restore acceptance and merge hold, not this PR's synthetic evidence.

## CI and rollback
The baseline job checks reproducibility, baseline-only init, catalog/seeds,
no app schemas, actual runner fresh/repeat, synthetic dump/restore adoption,
data/OID/ledger preservation, partial/checksum/untracked refusal and a post-cut
migration. Seed-drift regressions replay the archive. Ownership tests reject
app DDL/DML/search-path leaks and archive tampering against original main bytes,
not merely a mutable manifest.

Before any post-cut DDL lands, rolling code back to the pre-cut release still
recognizes all historical ledger rows; the extra baseline row is harmless.
Never remove rows or drop/recreate schemas to roll back. After post-cut DDL,
use the normal reviewed migration/backup recovery procedure; this squash adds
no automatic down-migration.