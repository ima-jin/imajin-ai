-- Migration: 0130_operator_approvals
-- Kernel half of #2059 — operator approvals (gateway restart / config
-- proposals) appear as a signed confirm on /jin, approvable from anywhere.
--
-- operator.approvals holds the proposal lifecycle, keyed by the OpenClaw
-- system-agent's proposal id:
--
--   pending   — awaiting the operator's decision. Created when the plugin
--               publishes an `operator.approval.requested` kernel
--               notification (POST /notify/api/send).
--   approved  — operator approved via /jin. "pending-apply" until the
--               plugin confirms the Gateway applied it.
--   denied    — operator denied via /jin. Terminal.
--   withdrawn — operator withdrew an approval before it was applied. Only
--               reachable from 'approved'. Terminal.
--   applied   — the plugin confirmed the proposal was applied. Only
--               reachable from 'approved'. Terminal.
--
-- Deliberately NOT a parallel notification queue: the notify.notifications
-- row created by /notify/api/send already gets WS push + backlog replay on
-- reconnect for free (#2044/#2050) — this table only tracks decision state.

CREATE SCHEMA IF NOT EXISTS operator;

CREATE TABLE IF NOT EXISTS operator.approvals (
  proposal_id      text        PRIMARY KEY,
  operator_did     text        NOT NULL,
  kind             text        NOT NULL,             -- 'restart' | 'config-mutation' | 'other'
  summary          text        NOT NULL,              -- never secret values (validated at ingestion)
  keys_touched     jsonb       NOT NULL DEFAULT '[]', -- key paths only, never resolved secret values
  notification_id  text,                              -- notify.notifications.id, when known
  status           text        NOT NULL DEFAULT 'pending',
  decision         jsonb,                             -- signed { payload, signature, senderPubkey }
  applied_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operator_approvals_operator
  ON operator.approvals (operator_did, status);

CREATE INDEX IF NOT EXISTS idx_operator_approvals_status
  ON operator.approvals (status);

-- operator.approval.decided is emitted back on the signed event stream for
-- the OpenClaw plugin to consume (delivered live via the #1884 grant-bound
-- event-subscription fan-out to any agent holding an active `operator:
-- approvals` grant — see packages/auth/src/grant-scopes.ts). No human-facing
-- notification is implied by the primitive itself.
INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
VALUES (
  'operator.approval.decided',
  NULL,
  '[{"type":"emit","config":{},"enabled":true}]'::jsonb,
  true
)
ON CONFLICT (event_type, scope) DO UPDATE
  SET reactors = EXCLUDED.reactors,
      updated_at = now();
