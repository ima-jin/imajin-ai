-- SELECT-only. Safe before or after 0240; no credential fields are projected.
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
SELECT source_table,
  count(*) FILTER (WHERE provider LIKE 'org-held-%') AS prefix_rows,
  count(*) FILTER (WHERE unprefixed NOT LIKE 'app-upstream:%' AND unprefixed LIKE '%-billing') AS suffix_rows,
  count(*) FILTER (WHERE unprefixed LIKE 'app-upstream:%') AS upstream_rows,
  count(*) FILTER (WHERE NOT convertible) AS unresolved_rows,
  count(*) FILTER (WHERE target_count > 1) AS collision_rows,
  count(DISTINCT jsonb_build_array(owner_did, member_did, target_provider, target_purpose, target_slot))
    FILTER (WHERE target_count > 1) AS collision_keys,
  0::bigint AS suspension_fold_rows,
  COALESCE(jsonb_agg(jsonb_build_object(
    'row', row_key, 'owner', owner_did, 'member', member_did,
    'provider', target_provider, 'purpose', target_purpose, 'slot', target_slot
  ) ORDER BY row_key) FILTER (WHERE target_count > 1), '[]'::jsonb) AS colliding_keys
FROM (VALUES ('connectors'), ('org_connection_suspensions')) AS sources(source_table)
LEFT JOIN candidates USING (source_table)
GROUP BY source_table
ORDER BY source_table;
