-- Migration: 0109_consent_requests
-- Generic consent-request primitive (#1817): external systems raise a
-- consent request that renders as a confirm card on /jin and resolves to a
-- signed decision. Generalizes the inference confirm gate
-- (#1782/#1784/#1791 chain) and the GitHub action-proposal rail
-- (#1366/#1429) to any app-authed requester holding `consent:write`.
--
-- consent_requests.requests holds three states, distinguished by status:
--
--   pending  — awaiting the approver's decision. Created by
--              raiseConsentRequest(); surfaced to /jin via the
--              consent.requested bus event + notify push (#1644/#1645).
--
--   approved | rejected — the approver decided. A kernel-witnessed
--              consent_requests.decisions row is minted and referenced via
--              decision_id.
--
--   expired  — the record's own expiry lapsed before the approver decided.
--              Resolved lazily (never a cron sweep) on every read/decision
--              path, so an expired request is never left silently pending.
--
-- consent_requests.decisions is the signed approval.decision attestation,
-- one row per resolved request, referencing the request id.

CREATE SCHEMA IF NOT EXISTS consent_requests;

CREATE TABLE IF NOT EXISTS consent_requests.requests (
  id                text        PRIMARY KEY,          -- creq_{nanoid}
  requester_did     text        NOT NULL,             -- app/system that raised the request
  approver_did      text        NOT NULL,             -- subject who must decide
  kind              text        NOT NULL,             -- requester-vocabulary request kind
  summary           text        NOT NULL,             -- human-readable: exactly what will happen
  detail            jsonb,                            -- optional structured payload for the card
  requester_scope   text        NOT NULL,             -- granted scope that authorized raising this
  -- State machine: pending → approved | rejected | expired
  status            text        NOT NULL DEFAULT 'pending',
  expires_at        timestamptz NOT NULL,
  resolved_at       timestamptz,
  decision_id       text,                             -- references consent_requests.decisions.id
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consent_requests_approver
  ON consent_requests.requests (approver_did, status);

CREATE INDEX IF NOT EXISTS idx_consent_requests_requester
  ON consent_requests.requests (requester_did, status);

-- Supports the lazy expiry sweep: WHERE status='pending' AND expires_at <= now()
CREATE INDEX IF NOT EXISTS idx_consent_requests_expiry
  ON consent_requests.requests (status, expires_at);

CREATE TABLE IF NOT EXISTS consent_requests.decisions (
  id              text        PRIMARY KEY,            -- cdec_{nanoid}
  request_id      text        NOT NULL,
  requester_did   text        NOT NULL,
  approver_did    text        NOT NULL,
  decision        text        NOT NULL,               -- 'approve' | 'reject'
  payload         jsonb       NOT NULL,                -- signed { requestId, approverDid, decision, kind, summaryDigest, ts }
  signature       text        NOT NULL,                -- Ed25519 hex signature over canonicalize(payload)
  sender_pubkey   text        NOT NULL,                -- kernel node signing identity (kernel-witnessed)
  signed_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_consent_decisions_request
  ON consent_requests.decisions (request_id);

CREATE INDEX IF NOT EXISTS idx_consent_decisions_approver
  ON consent_requests.decisions (approver_did);

-- Seed kernel.bus_chain_configs (mirrors migration 0084's pattern): route
-- consent.requested to the notify reactor so the approver gets a real-time
-- push (#1644/#1645) that surfaces the confirm card on /jin, plus emit so it
-- lands on the signed event stream. Kept in sync with packages/bus/src/config.ts.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'consent.requested',
  NULL,
  '[{"type":"emit","config":{},"enabled":true},{"type":"notify","config":{"title":"Consent requested: {{kind}}","body":"{{summary}}"},"enabled":true,"await":false}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();

-- approval.decision is emitted back for the requesting system to consume off
-- the signed event stream; no human-facing notification is implied by the
-- primitive itself (the requester is typically a machine, not a /jin viewer).
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'approval.decision',
  NULL,
  '[{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
