-- owner: kernel
-- #3318 A2. No credentials, grants, provenance, events, or connector ids are rewritten.
-- Suspension collisions abort (Ryan 2026-11-11); connector collisions are left untouched.
ALTER TABLE kernel.connectors ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'inference';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'connectors_purpose_check' AND conrelid = 'kernel.connectors'::regclass) THEN
    ALTER TABLE kernel.connectors ADD CONSTRAINT connectors_purpose_check
      CHECK (purpose IN ('inference', 'billing'));
  END IF;
END $$;

LOCK TABLE kernel.connectors, kernel.org_connection_suspensions IN SHARE ROW EXCLUSIVE MODE;
CREATE TEMP TABLE migration_0240_targets AS
WITH inputs AS (
  SELECT 'connectors'::text AS source_table, c.id AS row_key, c.owner_did,
    ''::text AS member_did, c.provider, c.slot,
    COALESCE(to_jsonb(c)->>'purpose', 'inference') AS purpose,
    c.upstream_binding,
    regexp_replace(c.provider, '^org-held-', '') AS unprefixed
  FROM kernel.connectors c
  UNION ALL
  SELECT 'org_connection_suspensions',
    jsonb_build_array(s.org_did, s.member_did, s.provider, s.slot)::text,
    s.org_did, s.member_did, s.provider, s.slot, '', NULL,
    regexp_replace(s.provider, '^org-held-', '')
  FROM kernel.org_connection_suspensions s
), declarations AS (
  SELECT 'app-upstream:' || a.app_did || ':' || (u.value->>'id') AS legacy_provider,
    lower(substring(u.value->>'origin' FROM '^https://(\[[^]]+\]|[^/:?#]+)(:[0-9]+)?$')) AS hostname
  FROM registry.apps a
  CROSS JOIN LATERAL jsonb_array_elements(a.upstreams) u(value)
), hosts AS (
  SELECT legacy_provider, min(hostname) AS hostname
  FROM declarations
  GROUP BY legacy_provider
  HAVING count(DISTINCT hostname) = 1
), targets AS (
  SELECT i.*,
    CASE WHEN i.unprefixed LIKE 'app-upstream:%' THEN
      CASE WHEN i.upstream_binding IS NOT NULL AND h.hostname IS NOT NULL
        THEN h.hostname ELSE i.provider END
      ELSE regexp_replace(i.unprefixed, '-billing$', '') END AS target_provider,
    CASE WHEN i.source_table = 'org_connection_suspensions' THEN ''
      WHEN i.unprefixed NOT LIKE 'app-upstream:%' AND i.unprefixed LIKE '%-billing'
        THEN 'billing' ELSE i.purpose END AS target_purpose,
    CASE WHEN i.unprefixed LIKE 'app-upstream:%'
      AND i.upstream_binding IS NOT NULL AND h.hostname IS NOT NULL
      THEN i.upstream_binding ELSE i.slot END AS target_slot,
    NOT (i.unprefixed LIKE 'app-upstream:%'
      AND (i.upstream_binding IS NULL OR h.hostname IS NULL))
      AND regexp_replace(i.unprefixed, '-billing$', '') <> '' AS convertible
  FROM inputs i
  LEFT JOIN hosts h ON h.legacy_provider = i.unprefixed
), candidates AS (
  SELECT *, count(*) OVER (
    PARTITION BY source_table, owner_did, member_did, target_provider, target_purpose, target_slot
  ) AS target_count
  FROM targets
)
SELECT * FROM candidates;

DO $$
DECLARE collisions jsonb;
BEGIN
  SELECT jsonb_agg(jsonb_build_object(
    'org_did', owner_did, 'member_did', member_did, 'vendor', target_provider,
    'slot', target_slot, 'source_key', row_key
  ) ORDER BY row_key) INTO collisions
  FROM migration_0240_targets
  WHERE source_table = 'org_connection_suspensions' AND target_count > 1;
  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION '0240 suspension normalized-key collisions: %', collisions;
  END IF;
END $$;

-- Rebuild only when the existing definition lacks purpose. Second execution is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'kernel'
    AND indexname = 'uniq_connectors_owner_provider_slot'
    AND indexdef NOT LIKE '%(owner_did, provider, purpose, slot)%') THEN
    DROP INDEX kernel.uniq_connectors_owner_provider_slot;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_connectors_owner_provider_slot
  ON kernel.connectors (owner_did, provider, purpose, slot);

DO $$
DECLARE item record;
DECLARE changed_count bigint := 0;
DECLARE collision_count bigint := 0;
DECLARE unresolved_count bigint := 0;
BEGIN
  -- Materialize this statement's snapshot before any update changes a candidate's window count.
  FOR item IN SELECT * FROM migration_0240_targets
    WHERE source_table = 'connectors' ORDER BY row_key
  LOOP
    IF NOT item.convertible THEN
      unresolved_count := unresolved_count + 1;
      RAISE NOTICE '0240 unresolved connector left untouched: %', item.row_key;
    ELSIF item.target_count > 1 THEN
      collision_count := collision_count + 1;
      RAISE NOTICE '0240 connector collision left untouched: id=% holder=% vendor=% purpose=% slot=%',
        item.row_key, item.owner_did, item.target_provider, item.target_purpose, item.target_slot;
    ELSIF (item.provider, item.purpose, item.slot)
      IS DISTINCT FROM (item.target_provider, item.target_purpose, item.target_slot) THEN
      UPDATE kernel.connectors
      SET provider = item.target_provider, purpose = item.target_purpose, slot = item.target_slot
      WHERE id = item.row_key;
      changed_count := changed_count + 1;
    END IF;
  END LOOP;
  RAISE NOTICE '0240 connectors: updated=% collision_rows=% unresolved_rows=%',
    changed_count, collision_count, unresolved_count;
END $$;

DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT * FROM migration_0240_targets
    WHERE source_table = 'org_connection_suspensions' ORDER BY row_key
  LOOP
    IF NOT item.convertible THEN
      RAISE NOTICE '0240 unresolved suspension left untouched: %', item.row_key;
    ELSIF item.provider IS DISTINCT FROM item.target_provider THEN
      UPDATE kernel.org_connection_suspensions SET provider = item.target_provider
      WHERE org_did = item.owner_did AND member_did = item.member_did
        AND provider = item.provider AND slot = item.slot;
    END IF;
  END LOOP;
END $$;

-- A prefix cannot identify an org DID. Report scope anomalies; never infer or reassign ownership.
DO $$
DECLARE item record;
BEGIN
  FOR item IN SELECT c.row_key AS id, c.owner_did FROM migration_0240_targets c
    LEFT JOIN auth.identities i ON i.id = c.owner_did
    WHERE c.provider LIKE 'org-held-%'
      AND c.source_table = 'connectors'
      AND (i.scope IS NULL OR i.scope NOT IN ('business', 'community', 'family'))
  LOOP
    RAISE NOTICE '0240 legacy holder requires review: id=% owner=%', item.id, item.owner_did;
  END LOOP;
END $$;
DROP TABLE migration_0240_targets;
