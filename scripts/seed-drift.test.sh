#!/usr/bin/env bash
# Real SQL, scratch only. Never reads .env files, DATABASE_URL or the environment
# migration runner. Requires Docker; no host ports, mounts, credentials or DB URLs.
# Usage: bash scripts/seed-drift.test.sh
set -euo pipefail
export LC_ALL=C
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="postgres:16-bookworm@sha256:0ea6700a3b4f0ae6ce746519073558aed4d88a79d8d07622a9a644946c7319c4"
MIGRATION="$ROOT/migrations/0201_reconcile_seed_era_drift.sql"
TMP="$(mktemp -d)"
CONTAINER=""
cleanup() {
  if [[ -n "$CONTAINER" ]]; then docker rm -f "$CONTAINER" >/dev/null; fi
  rm -rf "$TMP"
}
trap cleanup EXIT
die() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
command -v docker >/dev/null || die "Docker is required; no external DB fallback is permitted"
docker info >/dev/null || die "Docker daemon unavailable; no external DB will be used"
[[ -s "$MIGRATION" ]] || die "Reconciliation migration missing"

# Trust authentication is confined to an isolated, disposable container, with no
# network or published port. Inherited PG*/DATABASE_URL variables never enter it.
CONTAINER="$(docker run --detach --rm --network none \
  --tmpfs /var/lib/postgresql/data:rw \
  -e POSTGRES_HOST_AUTH_METHOD=trust "$IMAGE" -c autovacuum=off)"
for ((attempt=0; attempt<60; attempt++)); do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$CONTAINER" pg_isready -U postgres >/dev/null || die "Scratch PostgreSQL did not start"
sql() {
  local db="$1"; shift
  docker exec -i "$CONTAINER" psql -X -qAt -U postgres -d "$db" \
    --set=ON_ERROR_STOP=1 "$@"
}
apply() {
  local db="$1"
  sql "$db" --single-transaction < "$MIGRATION"
}
query() {
  local db="$1" statement="$2"
  sql "$db" -c "$statement"
}
assert() {
  local db="$1" statement="$2" message="$3"
  [[ "$(query "$db" "$statement")" == t ]] || die "$message"
}
clone() {
  local db="$1"
  query postgres "CREATE DATABASE $db TEMPLATE seed_drift_baseline" >/dev/null
}
schema() {
  local db="$1"
  docker exec "$CONTAINER" pg_dump -U postgres -d "$db" \
    --schema-only --no-owner --no-privileges |
    sed -E '/^\\(un)?restrict /s/ .*/ NORMALIZED_DUMP_TOKEN/'
}
catalog() {
  local db="$1"
  sql "$db" < "$ROOT/scripts/seed-drift-catalog.sql"
}
shape() {
  local db="$1"
  sql "$db" < "$ROOT/scripts/seed-drift-shape.sql"
}
identities() {
  local db="$1"
  query "$db" "SELECT n.nspname, c.relname, c.oid, c.relfilenode
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
    ORDER BY n.nspname, c.relname"
}
rows() {
  local db="$1"
  sql "$db" <<'SQL'
SELECT 'reads', xmin::text, to_jsonb(t) FROM chat.conversation_reads_v2 t ORDER BY to_jsonb(t)::text;
SELECT 'reactions', xmin::text, to_jsonb(t) FROM chat.message_reactions_v2 t ORDER BY to_jsonb(t)::text;
SELECT 'members', xmin::text, to_jsonb(t) FROM chat.conversation_members t ORDER BY to_jsonb(t)::text;
SELECT 'rollups', xmin::text, to_jsonb(t) FROM pay.balance_rollups t ORDER BY to_jsonb(t)::text;
SQL
}
snapshot() {
  local db="$1" label="$2"
  schema "$db" > "$TMP/$label.schema"
  catalog "$db" > "$TMP/$label.catalog"
  rows "$db" > "$TMP/$label.rows"
  identities "$db" > "$TMP/$label.identities"
}
same_snapshot() {
  local before="$1" after="$2" message="$3" suffix
  for suffix in schema catalog rows identities; do
    diff -u "$TMP/$before.$suffix" "$TMP/$after.$suffix" || die "$message ($suffix)"
  done
}
drop_keys() {
  local db="$1"
  sql "$db" <<'SQL'
ALTER TABLE chat.conversation_reads_v2 DROP CONSTRAINT conversation_reads_v2_conversation_did_did_pk;
ALTER TABLE chat.message_reactions_v2 DROP CONSTRAINT message_reactions_v2_message_id_did_emoji_pk;
SQL
}
assert_keys() {
  local db="$1"
  assert "$db" "SELECT count(*) = 2 FROM pg_constraint
    WHERE contype = 'p' AND (
      (conrelid = 'chat.conversation_reads_v2'::regclass AND
       pg_get_constraintdef(oid) = 'PRIMARY KEY (conversation_did, did)') OR
      (conrelid = 'chat.message_reactions_v2'::regclass AND
       pg_get_constraintdef(oid) = 'PRIMARY KEY (message_id, did, emoji)'))" "$db: exact ordered primary keys"
}

printf 'Bootstrapping all migrations directly with per-file transactions...\n'
query postgres 'CREATE DATABASE seed_drift_baseline' >/dev/null
count=0
for migration in "$ROOT"/migrations/[0-9][0-9][0-9][0-9]_*.sql; do
  if [[ "$migration" == "$MIGRATION" ]]; then snapshot seed_drift_baseline before_first; fi
  if ! sql seed_drift_baseline --single-transaction < "$migration" > "$TMP/bootstrap.log" 2>&1; then
    cat "$TMP/bootstrap.log" >&2
    die "Fresh bootstrap failed at $(basename "$migration")"
  fi
  if [[ "$migration" == "$MIGRATION" ]]; then
    snapshot seed_drift_baseline after_first
    same_snapshot before_first after_first "first application on fresh history must be a no-op"
  fi
  count=$((count + 1))
done
sql seed_drift_baseline --single-transaction < "$ROOT/scripts/seed-drift-fixture.sql"
assert_keys seed_drift_baseline
snapshot seed_drift_baseline fresh
shape seed_drift_baseline > "$TMP/fresh.shape"
for pass in 1 2; do
  apply seed_drift_baseline
  snapshot seed_drift_baseline "repeat$pass"
  same_snapshot fresh "repeat$pass" "fresh migration rerun $pass must be a catalog/OID/data no-op"
done
printf 'PASS: %s migrations; reconciliation reruns preserve full catalogs including OIDs\n' "$count"

# Both membership key orders must disappear regardless of constraint name.
for order in 'conversation_did, member_did' 'member_did, conversation_did'; do
  db="drift_$([[ "$order" == conversation* ]] && printf forward || printf reverse)"
  clone "$db"
  drop_keys "$db"
  sql "$db" <<SQL
CREATE UNIQUE INDEX fixture_reads_exact ON chat.conversation_reads_v2 (conversation_did, did);
CREATE UNIQUE INDEX fixture_reactions_exact ON chat.message_reactions_v2 (message_id, did, emoji);
ALTER TABLE chat.conversation_members ADD CONSTRAINT arbitrary_legacy_name UNIQUE ($order);
ALTER TABLE pay.balance_rollups ALTER COLUMN earned SET DEFAULT 0;
ALTER TABLE pay.balance_rollups ALTER COLUMN spent SET DEFAULT 0;
SQL
  index_oids="$(query "$db" "SELECT 'chat.fixture_reads_exact'::regclass::oid || ',' || 'chat.fixture_reactions_exact'::regclass::oid")"
  rows "$db" > "$TMP/before.rows"
  apply "$db"
  assert_keys "$db"
  [[ "$index_oids" == "$(query "$db" "SELECT 'chat.conversation_reads_v2_conversation_did_did_pk'::regclass::oid || ',' || 'chat.message_reactions_v2_message_id_did_emoji_pk'::regclass::oid")" ]] ||
    die "$db: exact unique indexes must be promoted, not rebuilt"
  schema "$db" > "$TMP/reconciled.schema"
  diff -u "$TMP/fresh.schema" "$TMP/reconciled.schema" || die "$db: full fresh schema convergence"
  shape "$db" > "$TMP/reconciled.shape"
  diff -u "$TMP/fresh.shape" "$TMP/reconciled.shape" || die "$db: full fresh catalog definition convergence"
  rows "$db" > "$TMP/after.rows"
  diff -u "$TMP/before.rows" "$TMP/after.rows" || die "$db: data/xmin preservation"
  snapshot "$db" repaired
  apply "$db"
  snapshot "$db" repaired_repeat
  same_snapshot repaired repaired_repeat "$db: repaired rerun no-op"
done
printf 'PASS: drift converges to full fresh schema, both membership orders; promoted index OIDs and rows retained\n'

clone fallback
drop_keys fallback
apply fallback
assert_keys fallback
schema fallback > "$TMP/fallback.schema"
diff -u "$TMP/fresh.schema" "$TMP/fallback.schema" || die "no-index fallback schema convergence"
shape fallback > "$TMP/fallback.shape"
diff -u "$TMP/fresh.shape" "$TMP/fallback.shape" || die "no-index fallback catalog convergence"
printf 'PASS: no matching index creates exact primary keys\n'

# One candidate at a time: an unsuitable index must survive and not become PK.
for variant in partial expression wrong_columns nonunique wrong_order included descending opclass collation invalid owned; do
  db="candidate_$variant"
  clone "$db"
  drop_keys "$db"
  case "$variant" in
    partial) definition='CREATE UNIQUE INDEX unsuitable ON chat.conversation_reads_v2 (conversation_did, did) WHERE did IS NOT NULL';;
    expression) definition='CREATE UNIQUE INDEX unsuitable ON chat.conversation_reads_v2 (conversation_did, lower(did))';;
    wrong_columns) definition='CREATE UNIQUE INDEX unsuitable ON chat.conversation_reads_v2 (conversation_did, last_read_at)';;
    nonunique) definition='CREATE INDEX unsuitable ON chat.conversation_reads_v2 (conversation_did, did)';;
    wrong_order) definition='CREATE UNIQUE INDEX unsuitable ON chat.conversation_reads_v2 (did, conversation_did)';;
    included) definition='CREATE UNIQUE INDEX unsuitable ON chat.conversation_reads_v2 (conversation_did, did) INCLUDE (last_read_at)';;
    descending) definition='CREATE UNIQUE INDEX unsuitable ON chat.conversation_reads_v2 (conversation_did DESC, did)';;
    opclass) definition='CREATE UNIQUE INDEX unsuitable ON chat.conversation_reads_v2 (conversation_did text_pattern_ops, did)';;
    collation) definition='CREATE UNIQUE INDEX unsuitable ON chat.conversation_reads_v2 (conversation_did COLLATE "C", did)';;
    invalid) definition='CREATE UNIQUE INDEX unsuitable ON chat.conversation_reads_v2 (conversation_did, did); UPDATE pg_index SET indisvalid = false WHERE indexrelid = '\''chat.unsuitable'\''::regclass';;
    owned) definition='ALTER TABLE chat.conversation_reads_v2 ADD CONSTRAINT unsuitable UNIQUE (conversation_did, did)';;
    *) die "Unexpected index variant: $variant";;
  esac
  query "$db" "$definition" >/dev/null
  original="$(query "$db" "SELECT 'chat.unsuitable'::regclass::oid")"
  apply "$db"
  assert_keys "$db"
  assert "$db" "SELECT indexrelid = $original AND NOT indisprimary FROM pg_index WHERE indexrelid = 'chat.unsuitable'::regclass" "$variant: unsuitable index promoted or lost"
done
printf 'PASS: ineligible partial/expression/columns/nonunique/order/INCLUDE/sort/opclass/collation/invalid/owned indexes not promoted\n'

clone different_pk
drop_keys different_pk
query different_pk 'ALTER TABLE chat.conversation_reads_v2 ADD CONSTRAINT alternate_reads_pk PRIMARY KEY (did, conversation_did); ALTER TABLE chat.message_reactions_v2 ADD CONSTRAINT alternate_reactions_pk PRIMARY KEY (emoji, did, message_id)' >/dev/null
snapshot different_pk different_before
apply different_pk
snapshot different_pk different_after
same_snapshot different_before different_after "preexisting different primary keys must be untouched"
printf 'PASS: different preexisting primary keys untouched\n'

# Refusal is transactional across the whole migration: no data/catalog damage
# even when the second table (after a possible first-table repair) is dirty.
for table in conversation_reads_v2 message_reactions_v2; do
  if [[ "$table" == conversation_reads_v2 ]]; then columns=(conversation_did did); else columns=(message_id did emoji); fi
  for bad in duplicates missing_column "${columns[@]}"; do
    db="bad_${table}_${bad}"
    clone "$db"
    drop_keys "$db"
    if [[ "$bad" == duplicates ]]; then
      query "$db" "INSERT INTO chat.$table SELECT * FROM chat.$table" >/dev/null
      expected='duplicate key values'
    elif [[ "$bad" == missing_column ]]; then
      query "$db" "ALTER TABLE chat.$table DROP COLUMN ${columns[1]}" >/dev/null
      expected='missing expected key columns'
    else
      query "$db" "ALTER TABLE chat.$table ALTER COLUMN $bad DROP NOT NULL; UPDATE chat.$table SET $bad = NULL" >/dev/null
      expected='NULL key values'
    fi
    snapshot "$db" bad_before
    if apply "$db" > "$TMP/error.log" 2>&1; then die "$db: migration accepted invalid keys"; fi
    grep -F "$expected" "$TMP/error.log" >/dev/null || { cat "$TMP/error.log" >&2; die "$db: missing clear $expected diagnostic"; }
    snapshot "$db" bad_after
    # PostgreSQL can update pg_class planner estimates (relpages/reltuples)
    # nontransactionally when CREATE INDEX on the first table is rolled back
    # after refusing the second table. Require unchanged logical definitions,
    # object identities/relfilenodes, and every row's xmin/content here.
    for suffix in schema rows identities; do
      diff -u "$TMP/bad_before.$suffix" "$TMP/bad_after.$suffix" ||
        die "$db: refusal must preserve schema, OIDs and data ($suffix)"
    done
  done
done
printf 'PASS: NULL in every key column, missing columns and duplicates in either table refuse atomically with clear errors\n'

clone unrelated
query unrelated 'ALTER TABLE chat.conversation_members ADD CONSTRAINT unrelated_member_unique UNIQUE (member_did, role)' >/dev/null
snapshot unrelated unrelated_before
apply unrelated
snapshot unrelated unrelated_after
same_snapshot unrelated_before unrelated_after "unrelated membership UNIQUE preserved"

for variant in nonzero missing nonnumeric expression; do
  db="default_$variant"
  clone "$db"
  case "$variant" in
    nonzero) ddl='ALTER COLUMN earned SET DEFAULT 5, ALTER COLUMN spent SET DEFAULT -2';;
    missing) ddl='ALTER COLUMN earned DROP DEFAULT, ALTER COLUMN spent DROP DEFAULT';;
    nonnumeric) ddl="ALTER COLUMN earned DROP DEFAULT, ALTER COLUMN spent DROP DEFAULT;
      ALTER TABLE pay.balance_rollups ALTER COLUMN earned TYPE text USING earned::text, ALTER COLUMN spent TYPE text USING spent::text;
      ALTER TABLE pay.balance_rollups ALTER COLUMN earned SET DEFAULT '0', ALTER COLUMN spent SET DEFAULT '0'";;
    expression) ddl='ALTER COLUMN earned SET DEFAULT (random() * 0), ALTER COLUMN spent SET DEFAULT (random() * 0)';;
    *) die "Unexpected default variant: $variant";;
  esac
  query "$db" "ALTER TABLE pay.balance_rollups $ddl" >/dev/null
  snapshot "$db" default_before
  apply "$db"
  snapshot "$db" default_after
  same_snapshot default_before default_after "$variant: unrelated defaults must be untouched"
done
printf 'PASS: unrelated member UNIQUE and nonzero/missing/nonnumeric/expression defaults unchanged\n'

# Empty DB covers absent schemas as well as absent target tables.
query postgres 'CREATE DATABASE missing_everything' >/dev/null
schema missing_everything > "$TMP/empty_before.schema"
catalog missing_everything > "$TMP/empty_before.catalog"
apply missing_everything
schema missing_everything > "$TMP/empty_after.schema"
catalog missing_everything > "$TMP/empty_after.catalog"
diff -u "$TMP/empty_before.schema" "$TMP/empty_after.schema" || die "missing tables/schema no-op"
diff -u "$TMP/empty_before.catalog" "$TMP/empty_after.catalog" || die "missing tables/schema catalog no-op"
query missing_everything 'CREATE SCHEMA chat; CREATE SCHEMA pay' >/dev/null
schema missing_everything > "$TMP/empty_before.schema"
catalog missing_everything > "$TMP/empty_before.catalog"
apply missing_everything
schema missing_everything > "$TMP/empty_after.schema"
catalog missing_everything > "$TMP/empty_after.catalog"
diff -u "$TMP/empty_before.schema" "$TMP/empty_after.schema" || die "missing tables with schemas present no-op"
diff -u "$TMP/empty_before.catalog" "$TMP/empty_after.catalog" || die "missing tables with schemas present catalog no-op"
printf 'PASS: absent schemas/tables and present-but-empty schemas no-op\nAll seed-drift PostgreSQL regressions passed.\n'
