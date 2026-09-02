-- 0117_connectors_registry_moonshot.sql
-- Extend the kernel.connectors shadow registry (0114) to the Moonshot AI
-- (Kimi) brain connector — Phase 1 of the inference connectors epic (#1922),
-- sub-issue #1930.
--
-- 0114 already created `kernel.connectors` and backfilled it for every
-- provider known at that time, including xAI (#1924); 0115 extended it to
-- OpenAI (#1927). Moonshot did not exist as a `CONNECTOR_REGISTRY` provider
-- yet, so no owner could have an active `auth.channel_links` row or a
-- `moonshot-api-key:*` vault delegation grant — there is nothing to backfill
-- retroactively. This migration exists so the registry's backfill logic is
-- generalized to Moonshot going forward (a fresh `moonshot-api-key:*` grant
-- sealed moments before this migration runs, in the gap between the
-- application deploy and this migration executing, would otherwise be
-- invisible to the registry until its next seal/revoke/publish).
--
-- Same shape as 0114/0115: full-outer-join the two independent sources, and
-- INSERT ... ON CONFLICT DO NOTHING so a re-run is a no-op and cannot clobber
-- a row the application already wrote.

WITH provider_map (provider, channel, connector_did, sealed_key_prefix) AS (
  VALUES
    ('moonshot', 'moonshot', 'did:imajin:moonshot-connector', 'moonshot-api-key')
),
linked AS (
  SELECT cl.did                                        AS owner_did,
         pm.provider,
         pm.channel,
         pm.connector_did,
         jsonb_agg(DISTINCT scope.value)               AS scopes,
         min(cl.created_at)                            AS created_at
    FROM auth.channel_links cl
    JOIN provider_map pm
      ON pm.channel = cl.channel
     AND pm.connector_did = cl.app_did
    CROSS JOIN LATERAL jsonb_array_elements_text(cl.scopes) AS scope(value)
   WHERE cl.status = 'active'
   GROUP BY cl.did, pm.provider, pm.channel, pm.connector_did
),
sealed AS (
  SELECT DISTINCT
         substr(g.field, strpos(g.field, ':') + 1)     AS owner_did,
         pm.provider,
         pm.channel,
         pm.connector_did,
         g.field                                       AS sealed_key_field
    FROM kernel.vault_delegation_grants g
    JOIN provider_map pm
      ON pm.sealed_key_prefix = split_part(g.field, ':', 1)
   WHERE g.status = 'active'
     AND substr(g.field, strpos(g.field, ':') + 1) LIKE 'did:%'
),
merged AS (
  SELECT COALESCE(l.owner_did, s.owner_did)            AS owner_did,
         COALESCE(l.provider, s.provider)              AS provider,
         COALESCE(l.channel, s.channel)                AS channel,
         COALESCE(l.connector_did, s.connector_did)    AS connector_did,
         s.sealed_key_field,
         COALESCE(l.scopes, '[]'::jsonb)               AS scopes,
         COALESCE(l.created_at, now())                 AS created_at
    FROM linked l
    FULL OUTER JOIN sealed s
      ON s.owner_did = l.owner_did
     AND s.provider = l.provider
)
INSERT INTO kernel.connectors (
  id, owner_did, provider, channel, connector_did, sealed_key_field, scopes, status, created_at, updated_at
)
SELECT 'conn_' || substr(encode(sha256((m.owner_did || '|' || m.provider)::bytea), 'hex'), 1, 24),
       m.owner_did,
       m.provider,
       m.channel,
       m.connector_did,
       m.sealed_key_field,
       m.scopes,
       'active',
       m.created_at,
       now()
  FROM merged m
ON CONFLICT (owner_did, provider) DO NOTHING;
