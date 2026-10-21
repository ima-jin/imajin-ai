-- 0123_agent_provisions.sql
-- Envelope provisioner (#1933, RFC-31 v2): turns the hand-built NanoClaw
-- first boot (#1932 -> PR #1960) into a repeatable flow. One row per
-- provisioning attempt/instance: an owner (serving_did) describes an agent
-- (handle, harness, placement, scopes, model/route) and the kernel mints
-- identity + minimal grants + assembles the RFC-31 envelope via
-- @imajin/claw-envelope, recording every step so a half-failed provision is
-- legible, not silent (see apps/kernel/src/lib/auth/agent-provisioner.ts).
--
-- serving_did     - the owner DID the new agent will belong to. Must equal
--                   the caller's own (non-delegated) effective DID at
--                   request time — enforced at the route layer, same
--                   "delegator acts directly" rule as
--                   auth.delegation_grants (#1882).
-- delegator_did   - the DID that actually called the provisioner API.
--                   Always equal to serving_did today (the route rejects
--                   X-Acting-For callers), kept as its own column so a
--                   future relaxation of that rule doesn't require a
--                   migration.
-- agent_did       - nullable until the identity-mint step succeeds.
-- harness         - 'nanoclaw' | 'openclaw'. 'openclaw' is a documented
--                   stub (#1933 deliverable 4) — validated but the envelope
--                   render step returns a "not yet implemented" error.
-- placement       - 'hosted' | 'local'.
-- model           - {provider, via} — mirrors claw-envelope's BrainChoice.
-- scopes          - requested grant capability strings (subset of
--                   @imajin/auth's closed GRANT_SCOPE_REGISTRY).
-- status          - 'pending' (row exists, no step has completed) ->
--                   'identity_minted' -> 'grants_issued' ->
--                   'envelope_rendered' -> ('awaiting_boot' for hosted only)
--                   -> 'booted' (via the runner's callback) | 'failed' |
--                   'revoked'. Monotonic forward except for 'failed'
--                   (any step) and 'revoked' (explicit action).
-- steps           - jsonb array of {step, status: 'ok'|'error', at, error?}
--                   — the partial-failure legibility log. Never contains
--                   secrets (keypairs are persisted only via the existing
--                   agent-creation response, never written into this row).
-- envelope_manifest - jsonb {files: [{relativePath}], manualSteps} — file
--                   NAMES and manual-step text only, never file contents
--                   (workspace files can carry the owner's stated purpose,
--                   but nothing secret; kept out of the DB regardless as a
--                   deliberate minimization — the bundle route recomputes
--                   full content on demand).
-- grant_id        - the single auth.delegation_grants(id) issued for this
--                   provision's requested scopes (one grant, one call to
--                   the existing issueGrant() with all scopes as its
--                   capabilities — not one grant per scope). Nullable until
--                   the grants-issue step succeeds. Revoking a provision
--                   revokes this grant via the existing revokeGrant().
-- idempotency_key - caller-supplied opaque string. Combined with
--                   delegator_did as the retry dedupe key so a network
--                   retry of the same logical request never re-mints an
--                   identity or re-issues grants.
CREATE TABLE IF NOT EXISTS auth.agent_provisions (
  id                 TEXT        PRIMARY KEY,
  serving_did        TEXT        NOT NULL,
  delegator_did      TEXT        NOT NULL,
  agent_did          TEXT,
  handle             TEXT        NOT NULL,
  display_name       TEXT,
  harness            TEXT        NOT NULL,
  placement          TEXT        NOT NULL,
  model              JSONB       NOT NULL DEFAULT '{}'::jsonb,
  scopes             JSONB       NOT NULL DEFAULT '[]'::jsonb,
  status             TEXT        NOT NULL DEFAULT 'pending',
  steps              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  envelope_manifest  JSONB,
  grant_id           TEXT,
  idempotency_key    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at         TIMESTAMPTZ
);

-- Retry dedupe: a second POST with the same (delegator_did, idempotency_key)
-- must resolve to the same row rather than minting a second identity.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_agent_provisions_delegator_idempotency
  ON auth.agent_provisions (delegator_did, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Agent View list query (#1933 deliverable 3): every provision for a DID's
-- own agents, optionally filtered by status.
CREATE INDEX IF NOT EXISTS idx_agent_provisions_serving_did
  ON auth.agent_provisions (serving_did, status);

-- Look up a provision by the agent it minted (e.g. to join provision state
-- onto GET /auth/api/agents's existing agent list).
CREATE INDEX IF NOT EXISTS idx_agent_provisions_agent_did
  ON auth.agent_provisions (agent_did)
  WHERE agent_did IS NOT NULL;
