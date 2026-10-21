-- 0114_connectors_registry.sql
-- First-class connector registry — Phase 1 of the inference connectors epic
-- (#1922), sub-issue #1924.
--
-- Before this migration there was NO `connectors` table. A connector's state
-- was spread across four places with nothing joining them:
--   auth.channel_links            — scopes + status per (did, channel, app_did)
--   kernel.vault_delegation_grants— ECDH-wrapped field keys per vault field
--   the file vault (vault.json)   — the AES-GCM sealed ciphertext itself
--   CONNECTOR_REGISTRY (static TS)— which connectors the platform supports
--
-- Two consequences: there was no row to hang a spend cap or a lease TTL on
-- (both are required by Phase 3 metering), and answering "which providers has
-- this DID connected?" meant a scan of channel_links plus a vault probe per
-- candidate field.
--
-- ── Consolidation decision: SHADOW, do not replace ───────────────────────────
-- #1924 asks explicitly: "replace channel_links entirely, or shadow during
-- migration?" This migration shadows, deliberately:
--
--   * `auth.channel_links` stays AUTHORITATIVE for grant checks. Every
--     connector's fail-closed gate (`resolveActiveGrant` in
--     connector-token-paste.ts / connector-static-secret.ts / connector-oauth.ts)
--     reads it on the hot path, and the scope-manifest projection reactor
--     writes it. Repointing those at a table that is one release old would put
--     a brand-new join in front of every credential unseal — a fail-closed
--     path where a bug reads as "you have no connector".
--   * `kernel.vault_delegation_grants` stays AUTHORITATIVE for custody. The
--     registry records only the vault FIELD NAME (`sealed_key_field`) — a
--     reference, never key material, never a wrapped key, never a ciphertext.
--     Nothing here is re-sealed and no existing grant is touched: the sealed
--     key still never leaves the kernel and there is still no raw-key release
--     path of any kind.
--   * `kernel.connectors` becomes the first-class home for what previously had
--     nowhere to live: the (owner, provider) identity itself, its spend cap,
--     and its lease TTL — plus a scope snapshot for cheap listing.
--
-- Replacing channel_links is a follow-up once the passthrough (Phase 2) and
-- metering (Phase 3) actually read this table in anger. Doing it here would
-- have been a migration whose only proof of correctness was that nothing had
-- exercised it yet.
--
-- ── Expiry semantics ────────────────────────────────────────────────────────
-- `expires_at` is a plain timestamp compared at read time, matching the
-- convention set by 0063 (vault delegation grants) and 0099 (delegation
-- grants): `status` only ever moves 'active' -> 'revoked', there is no
-- background sweep flipping expired rows, and renewal bumps `expires_at` in
-- place. A cached status that claims 'active' past its expiry is exactly the
-- failure those two migrations were written to avoid.

CREATE SCHEMA IF NOT EXISTS kernel;

CREATE TABLE IF NOT EXISTS kernel.connectors (
  id                TEXT        NOT NULL PRIMARY KEY,           -- conn_{hash of owner+provider}
  owner_did         TEXT        NOT NULL,                        -- DID whose connector this is
  provider          TEXT        NOT NULL,                        -- CONNECTOR_REGISTRY id, e.g. 'xai'
  channel           TEXT        NOT NULL,                        -- auth.channel_links.channel
  connector_did     TEXT        NOT NULL,                        -- auth.channel_links.app_did
  -- Vault FIELD NAME of the sealed credential, e.g. 'xai-api-key:did:imajin:…'.
  -- A reference only: the ciphertext lives in the vault and the wrapped field
  -- key in kernel.vault_delegation_grants. NULL for connectors with no single
  -- per-DID sealed credential (the native MCP connector).
  sealed_key_field  TEXT,
  scopes            JSONB       NOT NULL DEFAULT '[]'::jsonb,    -- snapshot; channel_links is authoritative
  -- Declared spend ceiling, enforced kernel-side by the Phase 3 passthrough
  -- (#1922). JSONB rather than columns because the shape is not settled yet
  -- (per-window vs per-turn vs per-model) and guessing it into DDL now would
  -- cost a second migration to correct.
  spend_cap         JSONB,
  expires_at        TIMESTAMPTZ,                                 -- lease end; NULL = no expiry
  status            TEXT        NOT NULL DEFAULT 'active',       -- 'active' | 'revoked'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ,
  CONSTRAINT uniq_connectors_owner_provider UNIQUE (owner_did, provider)
);

-- Dashboard read: every connector this DID has, in one query.
CREATE INDEX IF NOT EXISTS idx_connectors_owner
  ON kernel.connectors (owner_did, status);

-- Operator read: who is on a given provider (spend rollups, provider incidents).
CREATE INDEX IF NOT EXISTS idx_connectors_provider
  ON kernel.connectors (provider, status);

-- Lease-expiry observability, mirroring 0063/0099.
CREATE INDEX IF NOT EXISTS idx_connectors_expires
  ON kernel.connectors (expires_at)
  WHERE expires_at IS NOT NULL AND status = 'active';

-- Resolve a delivery/callback back to its owner without scanning.
CREATE INDEX IF NOT EXISTS idx_connectors_sealed_key_field
  ON kernel.connectors (sealed_key_field)
  WHERE sealed_key_field IS NOT NULL;

-- ── Backfill ────────────────────────────────────────────────────────────────
--
-- Two independent sources, full-outer-joined, because a connector can legitimately
-- exist in either one alone:
--   linked — an active auth.channel_links row: scopes were granted.
--   sealed — an active kernel.vault_delegation_grants row whose field name is
--            `{prefix}:{ownerDid}`: a key is sealed and readable. This covers the
--            owner who pasted a key but has not toggled scopes yet, which is
--            invisible to channel_links.
--
-- Owner DID is parsed out of the vault field name rather than read from
-- `subject`, because token-paste connectors self-grant to the NODE (see
-- revokeVaultDelegationGrantsForConnector) — `subject` is the node DID there,
-- while the field name always encodes the owner.
--
-- Rows that are dead on both axes are deliberately NOT backfilled: this is a
-- registry of live connector installations, not an archive of every DID that
-- ever touched one. `ON CONFLICT DO NOTHING` makes a re-run a no-op and, more
-- importantly, makes the backfill unable to clobber a row written by the
-- application after the migration first ran.

WITH provider_map (provider, channel, connector_did, sealed_key_prefix) AS (
  VALUES
    ('mcp',        'mcp',        'did:imajin:mcp-connector',        NULL::text),
    ('github',     'github',     'did:imajin:github-connector',     'github-oauth'),
    ('discord',    'discord',    'did:imajin:discord-connector',    'discord-bot-token'),
    ('gemini',     'gemini',     'did:imajin:gemini-connector',     'gemini-api-key'),
    ('anthropic',  'anthropic',  'did:imajin:anthropic-connector',  'anthropic-api-key'),
    ('gcp',        'gcp',        'did:imajin:gcp-connector',        'gcp-api-key'),
    ('quickbooks', 'quickbooks', 'did:imajin:quickbooks-connector', 'quickbooks-oauth'),
    ('warp',       'warp',       'did:imajin:warp-connector',       'warp-agent-key'),
    ('stripe',     'stripe',     'did:imajin:stripe-connector',     'stripe-api-key'),
    ('xai',        'xai',        'did:imajin:xai-connector',        'xai-api-key')
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
