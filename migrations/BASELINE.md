# Kernel baseline

## Scope and current cut

Kernel schemas: `auth`, `chat`, `connections`, `consent_requests`, `github`,
`inference`, `kernel`, `media`, `money`, `notify`, `operator`, `pay`, `profile`,
`registry`, `relay`, `usage`, `www`. App schemas and ledgers belong in app repos.
Fresh kernel init does not initialize coffee, dykil, events, learn, links or
market; existing app schemas and data are never dropped.

`kernel-baseline.json` is the authority for the fixed cut, absorbed filenames,
canonical checksums and exact accepted historical variants. The cut is through
`0215_registry_apps_sign_in_audience.sql`. Every later root migration remains
outside that inventory and runs in filename order only if absent from the ledger.
Missing pre-cut history is never tolerated.

Choose a migration number above the latest root file on current main, not
immediately after the baseline filename. Ordinary schema work does not move
the cut, rewrite the archive, regenerate seeds or normalize ledger rows.
The ownership map controls the kernel boundary; source presence is not evidence
that any production migration or restore has run.

## Pending root migration contracts

The root migrations below are kernel-owned in `ownership.json`, additive and idempotent:

- `0231_usage_projection_chain.sql` upserts the `usage.incurred` row in `kernel.bus_chain_configs` with NULL scope so the chain runs attestation, emit and the usage-projection reactor. The reactor writes the existing `usage.incurred` table keyed by the usage id; it adds no table.
- `0232_loop_event_signed_receipts.sql` adds nullable `signature`, `publisher_did` and `cause_event_id` columns to `kernel.loop_events`, a self-referencing `cause_event_id` foreign key and its index. Historical unsigned rows stay unsigned.
- `0233_mail_domains.sql` adds `kernel.mail_domains` with the Postal domain id, exact DNS records, verification state, operation claim and ownership-binding attestation id, plus a pending-check index on `next_check_at`. It holds no credentials.
- `0234_pay_transactions_source_kind_fee.sql` widens the `pay.transactions.source_kind` check to allow `fee`, so fee wallet-effect claims reuse `transactions.idempotency_key` and a retried `fee.*` receipt credits once.
- `0235_fee_ledger_projection.sql` adds a nullable `receipt_id` to `pay.fee_ledger` with a unique index, and upserts the `fee.record`, `fee.rebate` and `fee.surcharge` chains in `kernel.bus_chain_configs` at NULL scope as awaited loop-projection → fee-ledger → emit, so `pay.fee_ledger` rows are projected from signed receipts. Scoped rows get the same reactors and keep their enabled policy. Historical rows stay unsigned.
- `0236_relay_055_store_contract.sql` adds the DFOS relay 0.55 store-contract columns: `relay.relay_pending_operations.origin` (default `direct`), `relay.relay_operation_log.ingested_at`, a nullable `relay.relay_revocations.signed_created_at` (legacy revocations keep an unknown boundary and are read fail-closed), and `signed_created_at`, `ingested_at` and `revoked_by` on `relay.relay_public_credentials`. A revoked credential is hidden through `revoked_by`, which names the signed revocation; no rows are deleted.
- `0237_database_runtime_bounds.sql` is an idempotent `SELECT 1`. The shared `@imajin/db` client sets `statement_timeout` and `idle_in_transaction_session_timeout` per connection, so no role or database default changes and no schema or data rewrite runs. Defaults and `DB_*` overrides are in [deploy/README.md](../deploy/README.md#database-deadlines-and-pool-stall-reproduction).

Apply these files in filename order only when absent from the ledger, after any pending `0228`–`0230` files. The fixed cut through `0215`, baseline inventory, historical checksums and existing ledger rows remain unchanged.

## Known name-only drift
The recorded deployed and fresh-baseline catalogs have identical definitions
but six different names (deployed → fresh baseline):
- `auth.identity_chains`: `identity_chains_did_fkey` → `identity_chains_did_identities_id_fk`.
- `chat.conversation_members`: `conversation_members_conversation_did_fkey` → `conversation_members_conversation_did_conversations_v2_did_fk`.
- `chat.conversation_reads_v2`: `conversation_reads_v2_conversation_did_fkey` → `conversation_reads_v2_conversation_did_conversations_v2_did_fk`.
- `chat.message_reactions_v2`: `message_reactions_v2_message_id_fkey` → `message_reactions_v2_message_id_messages_v2_id_fk`.
- `chat.messages_v2`: `messages_v2_conversation_did_fkey` → `messages_v2_conversation_did_conversations_v2_did_fk`.
- `registry.interests`: `interests_scope_key` → `interests_scope_unique`.
These names are not changed here and are separate from ledger checksums.

## Recorded historical checksum drift
`kernel-baseline.json.acceptedHistoricalChecksums` records **only**
these exact extra SHA-256 values, per filename, with `observedIn`, `reason`
and `evidence`. Four were observed on both dev/prod; four only on dev:
- `0001_seed.sql` — dev/prod: `9d75ca47c372992e02a178b5d6001ee3689e77b8fa94ad14fa1cdf75843d8aea`
- `0010_logs_cleanup.sql` — dev/prod: `455f387dd93c5f36843d5a278840e593556f5590d8973e8b9346dc2b67021a39`
- `0039_seed_bus_chain_configs.sql` — dev/prod: `cc5ed2c9bafb8b1f2b8ab04d9149f2ede9706c3a74d8f8cc9d45cee032b28a59`
- `0042_seed_calendar_chain_configs.sql` — dev/prod: `a17b873c79706f08e4996784f3fa18af13f6fb2744311a3516cb02374bb659dc`
- `0056_consent_grants.sql` — dev: `89e67ab66003769e9e05bd7ec2865c97a16a6573d1018647f57785433fcc1775`
- `0057_profile_field_visibility.sql` — dev: `c1c675e6f4ea6362bcfb9dd0e805bcb458a449afc46b8fa8e9382bc5f0e7cfc7`
- `0068_inference_engine.sql` — dev: `16edc9b984bbf7e4f512aa638ec52734a939682eb8e8ea67a2dc326aaee0d5d8`
- `0071_inference_attestation_signatures.sql` — dev: `bdf060a42f7594f281194eebcfd03b5308116ad3440f5e296dd451caf533b43a`

The legacy runner warned and skipped changed applied files, allowing these
historical ledger variants to persist. Acceptance is a reviewed, exact
compatibility record, not permission to alter history or ignore checksums.
The runner accepts the canonical archive checksum **or that file's recorded
variant**; an unrecorded value, including a variant borrowed from another
filename, still throws. Every pre-cut row remains required.
**Never UPDATE, DELETE, normalize or reseed historical ledger rows.**
The only additions are the baseline row and genuinely pending post-cut
migration rows. Regeneration preserves/validates the variant map; unit tests
pin all eight values independently to the compatibility contract. Scratch ledger fixtures
insert these synthetic rows at construction, then assert their full IDs,
checksums and timestamps are unchanged by adoption.

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

Run from the dedicated PR worktree. `generate` is explicitly pinned to 0215
and replays archived history plus root SQL at or below that cut, excluding
the baseline, in filename order/per-file transactions.
It generates the kernel-only dump/static seeds/manifest, then moves absorbed
files unchanged to `archive/pre-kernel-baseline/`. Commit/push after the final
rebase, and inspect main once more before readiness. `check` regenerates from
the archive and fails on byte drift; neither mode absorbs 0216 or later files.
Changing the cut requires a separately reviewed generator/manifest update.
Ordinary migration execution scans root SQL only. The complete mixed-owner
history is retained for audit/dependency-correct scratch replay, not app
migration authority.

DDL uses dependency-aware `pg_dump` ordering from the pinned image, without
owners/ACLs, patch-version comments or random psql restrict tokens. All other
DDL/session settings remain. Baseline-only and full-history kernel catalog
dumps and normalized static seed content must match. The required `public.pgcrypto`
extension is installed explicitly and its version/schema inventory is compared
separately; the public ledger itself is not baseline-managed DDL. Fresh baseline
plus **all** post-cut root files must match full-history replay through the last
root file, including normalized static seeds.

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
`created_at`/`updated_at` use the generator's fixed seed-bookkeeping instant. Chain/template
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
- Complete history: every archived filename must exist and its checksum must
  match the canonical value or an exact recorded per-file variant, and kernel
  schemas must exist. Insert **only** the baseline ledger row, no DDL/seeds.
  All historical ledger rows remain untouched. Missing 0216 is not missing
  pre-cut history: it is a normal pending root migration after adoption.
- Empty untracked database: apply baseline and record atomically.
- Partial/checksum-mismatched history, unknown ledger state or existing
  untracked kernel: stop; no force-adoption or reconstruction.

Afterward, only post-cut root SQL runs. The blind `seed-migrations.mjs` path
is disabled for this layout. Finish missing historical migrations using reviewed
pre-baseline code in a separately reviewed recovery operation; never delete
ledger rows to force a fresh init. Explicit environment `DATABASE_URL` takes
precedence over the legacy env-file fallback. Scratch copies no env files.
App `--owner` flags are legacy filtering, not app init; each app repository's
runner/APP_DB_SCHEMA owns that.

**Prod is re-baselined, never re-initialized.** Normal release deployment
adopts a complete ledger without DDL. This does not repair schema drift.

## Actual dev-restore dry run (operator only)
The operator supplies an already verified **custom-format** dev backup, including
`public._migrations` and app schemas, via the established backup procedure.
Backup acquisition is outside this runbook. Do not source/print env files,
put live URLs in commands, or run migration commands against dev/prod.
Use a server with Docker access and enough memory for the restore's tmpfs.

```bash
git fetch origin main
RESTORE_WORKTREE=$(mktemp -d /tmp/imajin-baseline-restore-XXXXXX)
git worktree add --detach "$RESTORE_WORKTREE" origin/main
cd "$RESTORE_WORKTREE"
git rev-parse HEAD
pnpm install --frozen-lockfile --ignore-scripts --filter imajin-ai
python3 scripts/kernel-baseline.py check
read -r -p 'Absolute path to verified custom-format dev backup: ' DEV_RESTORE_DUMP
test -f "$DEV_RESTORE_DUMP"
python3 scripts/kernel-baseline.py restore --dump "$DEV_RESTORE_DUMP"
```

The command restores the supplied file into an isolated scratch container
using `pg_restore --no-owner --no-privileges --exit-on-error`, then runs the
actual migration runner twice, with a localhost URL only inside that container.
Before running the runner, it clones the restored scratch database and independently
replays **every pending post-cut root file** on that reference, in filename order.
The adopted kernel DDL, extension inventory and non-ledger data/sequence values
must match that reference, not the untouched restore: 0217 changes schema and
0218 changes static seed data. For this independent replay comparison only, the
existing static-seed ID/timestamp normalization above handles generated UUIDs
and `now()`; non-seed data is not normalized. With no pending files, data is
compared raw. Existing relation OIDs/relfilenodes untouched by pending SQL must
survive. Every existing ledger row (including IDs/checksums/timestamps and
already-recorded post-cut rows) must remain byte-for-byte unchanged.
Exactly one baseline row must exist; additional ledger rows are only that baseline
(if absent) and **all** genuinely pending files with canonical checksums.
Existing post-cut files are skipped. After the first run, the second run must
preserve raw schema/data, relation OIDs/relfilenodes, representative row xmin and
the entire ledger without normalization. It does not deploy or modify the source
DB/backup.

If the server has no Docker, use the established
operator `pg_dump -Fc` / `pg_restore --no-owner --no-privileges --exit-on-error`
procedure into an already-isolated **scratch** database, from a throwaway
checkout with **no env files**. With operator-provided credentials exported
securely as a scratch-only `DATABASE_URL`, run these exact commands twice:

```bash
node scripts/migrate.mjs --owner kernel
node scripts/migrate.mjs --owner kernel
```

Compare scratch-only schema/data against an independent copy with every pending
post-cut migration replayed, and verify all existing ledger rows are unchanged.
Allow only a baseline row plus canonical rows for the pending post-cut files,
not just 0216. Check the second run is a strict no-op. Never point these commands
at live dev/prod or rewrite a historical checksum. The operator owns and records the
real-data proof.

Expected final line:
`PASS: supplied restore plus all pending post-cut migrations matches replay; historical ledger preserved; repeat is mutation-free`

Failure means stop and leave the PR unmerged. Record only a sanitized error
and exact SHA in the review, never backup contents, rows or credentials. Investigate
missing history/checksum errors; do not edit the ledger to bypass them.
Record successful command, exact SHA, backup provenance/time (not contents),
PostgreSQL build and PASS result in the review. Synthetic evidence alone
does not establish real dev-restore acceptance.

## CI and rollback
The baseline job checks reproducibility, baseline-only init, catalog/seeds,
no app schemas, actual runner fresh/repeat, synthetic dump/restore adoption,
data/OID/ledger preservation, partial/checksum/untracked refusal and all post-cut
migrations. Recorded prod-shaped fixtures apply every post-cut file; dev-shaped
fixtures skip every recorded file. Two additional schema-changing scratch files
(create a table, then add a column) prove N > 1, without adding root migrations.
Unit regressions reject an omitted later file, ledger rewrites/extra rows/wrong
checksums, unexpected identity changes and repeat-run mutation.
Seed-drift regressions replay the archive. Ownership tests reject
app DDL/DML/search-path leaks and archive tampering against original main bytes,
not merely a mutable manifest.

Before any post-cut DDL lands, rolling code back to reviewed pre-baseline code still
recognizes all historical ledger rows; the extra baseline row is harmless.
Never remove rows or drop/recreate schemas to roll back. After post-cut DDL,
use the normal reviewed migration/backup recovery procedure; baseline adoption adds
no automatic down-migration.