-- Migration: 0073_github_action_proposals
-- Creates the github schema and action_proposals table for the human-confirm rail
-- (#1366 children 1+2: github_update_issue tool + confirm rail).
--
-- github.action_proposals holds three kinds of rows (distinguished by status):
--
--   pending  — a mutate write was proposed but no live approval exists yet.
--              Created by requireMutateGate(); surfaced to the /jin dashboard.
--
--   approved — the human approved the proposal (single-call or windowed TTL).
--              approved_until IS NULL  → single-call (consumed on next write)
--              approved_until IS SET   → windowed (stays active until expiry;
--              each execution under the window inserts a fresh 'done' row)
--
--   done     — the write executed successfully. Both single-call approvals
--              (status transition) and windowed-approval executions (new row)
--              land here. Used as the source of truth for rate-limit counting.
--
-- Rate-limit query:
--   SELECT count(*) FROM github.action_proposals
--   WHERE owner_did = $1 AND status = 'done'
--   AND created_at > now() - '1 hour'::interval

CREATE SCHEMA IF NOT EXISTS github;

CREATE TABLE IF NOT EXISTS github.action_proposals (
  id                   text        PRIMARY KEY,          -- proposal_{nanoid}
  owner_did            text        NOT NULL,             -- DID of the resource owner
  agent_did            text,                             -- DID of the acting agent (optional)
  scope                text        NOT NULL,             -- 'github:write'
  tool                 text        NOT NULL,             -- 'github_update_issue'
  risk_tier            text        NOT NULL,             -- 'append' | 'mutate'
  target               text        NOT NULL,             -- 'owner/repo#issueNumber'
  args_summary         text        NOT NULL,             -- human-readable, never raw secrets
  -- State machine: pending → approved → done
  -- Windowed approvals: approved row stays; each execution inserts a new done row.
  status               text        NOT NULL DEFAULT 'pending',
  approved_until       timestamptz,                      -- NULL = single-call; SET = windowed TTL
  owner_authorization  jsonb,                            -- signed auth { payload, signature, senderPubkey }
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_github_action_proposals_owner
  ON github.action_proposals (owner_did);

CREATE INDEX IF NOT EXISTS idx_github_action_proposals_status
  ON github.action_proposals (status);

-- Supports the live-grant lookup in requireMutateGate():
-- WHERE owner_did=? AND scope=? AND risk_tier=? AND status='approved'
CREATE INDEX IF NOT EXISTS idx_github_action_proposals_gate
  ON github.action_proposals (owner_did, scope, risk_tier, status);

-- Supports the rate-limit window count:
-- WHERE owner_did=? AND status='done' AND created_at > now()-interval
CREATE INDEX IF NOT EXISTS idx_github_action_proposals_done_window
  ON github.action_proposals (owner_did, status, created_at);
