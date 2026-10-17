-- Migration: 0158_notify_templates
-- owner: kernel
-- #1510 — data-driven notify templates: a `notify_templates` row per scope
-- (subject/body/html + urgency + enabled), so adding an emailable scope
-- becomes a config operation instead of a code+deploy operation.
--
-- `getTemplate()` (apps/kernel/src/lib/notify/template-store.ts) reads this
-- table through a cached lookup (bus hot-reload on `notify.template.updated`)
-- and falls back to the in-code registry
-- (apps/kernel/src/lib/notify/templates.ts) whenever no row exists or a row
-- is disabled. Every row seeded below ships with `enabled = false` — the
-- backfill is a content/parity review checkpoint, not a behavior change:
-- flipping a scope to `enabled = true` (a plain UPDATE, no deploy) is the
-- explicit cutover step once its rendered output has been verified against
-- the in-code template it replaces. See the PR body for the DECISION note
-- on which ~16 of the ~26 in-code scopes were backfillable with the SAFE
-- `{{field}}` / `{{cta:field:Label}}` renderer (template-renderer.ts) —
-- the remainder have loop/conditional logic (QR ticket rows, role-based
-- copy, computed URLs) the generic renderer does not attempt to express,
-- and are left as code-only with no row here.

CREATE TABLE IF NOT EXISTS notify.templates (
  id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  scope       TEXT NOT NULL UNIQUE,
  urgency     TEXT NOT NULL DEFAULT 'normal',
  subject_tpl TEXT NOT NULL,
  body_tpl    TEXT NOT NULL,
  html_tpl    TEXT,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  created_by  TEXT,
  updated_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notify_templates_scope
  ON notify.templates (scope);

-- Backfill (#1510) — disabled on arrival, see header. `created_by`/`updated_by`
-- are 'migration:0158' rather than a DID: this is a code-authored seed, not
-- an operator edit.
INSERT INTO notify.templates
  (scope, urgency, subject_tpl, body_tpl, html_tpl, enabled, created_by, updated_by)
VALUES
  ('market:sale', 'normal',
    'Your listing sold!',
    'Your listing "{{listingTitle}}" has been sold.',
    'Your listing "{{listingTitle}}" has been sold.',
    false, 'migration:0158', 'migration:0158'),
  ('market:purchase', 'normal',
    'Purchase confirmed',
    'Your purchase of "{{listingTitle}}" is confirmed.',
    'Your purchase of "{{listingTitle}}" is confirmed.',
    false, 'migration:0158', 'migration:0158'),
  ('event:ticket', 'normal',
    'Ticket confirmed — {{eventTitle}}',
    'Your ticket for "{{eventTitle}}" is confirmed.',
    'Your ticket for "{{eventTitle}}" is confirmed.',
    false, 'migration:0158', 'migration:0158'),
  ('event:registration', 'normal',
    'Registration complete — {{eventTitle}}',
    'You''re registered for "{{eventTitle}}".',
    'You''re registered for "{{eventTitle}}".',
    false, 'migration:0158', 'migration:0158'),
  ('coffee:tip', 'normal',
    'You received a tip!',
    'You received a tip of {{amount}}.',
    'You received a tip of {{amount}}.',
    false, 'migration:0158', 'migration:0158'),
  ('coffee:tip-sent', 'low',
    'Tip sent',
    'Your tip of {{amount}} was sent.',
    'Your tip of {{amount}} was sent.',
    false, 'migration:0158', 'migration:0158'),
  ('connection:invite-accepted', 'normal',
    'Invitation accepted',
    '{{name}} accepted your invitation.',
    '{{name}} accepted your invitation.',
    false, 'migration:0158', 'migration:0158'),
  -- CTA showcase (#1510 acceptance example): `{{creatorName}} sent you
  -- {{title}}` plus a `{{signUrl}}` button via the whitelisted
  -- {{cta:signUrl:Label}} construct.
  ('auth:document-signature-request', 'urgent',
    '{{creatorName}} sent you a document to sign — Imajin',
    'You have been asked to review and sign "{{title}}".',
    '{{creatorName}} has asked you to review and sign {{title}}. {{cta:signUrl:Review & sign the document}}',
    false, 'migration:0158', 'migration:0158'),
  ('attest.pending_signature', 'urgent',
    'Attestation awaiting your signature — {{type}}',
    'Someone issued a "{{type}}" attestation naming you as the counterparty. Review and countersign to complete it.',
    'You have been named as the counterparty on a {{type}} attestation that is awaiting your signature. {{cta:originUrl:Review pending signatures}}',
    false, 'migration:0158', 'migration:0158'),
  ('auth:recovery-code-used', 'urgent',
    'Security alert: a recovery code rotated your account key',
    'Someone used one of your recovery codes to rotate your account key. If this wasn''t you, secure your account immediately.',
    'One of your one-time recovery codes was just used to authorize a key rotation on your account at {{occurredAt}}. Your old key is now cryptographically dead and every existing session has been signed out. If this was you, no action is needed. If it was not, contact support immediately.',
    false, 'migration:0158', 'migration:0158'),
  ('operator.approval.requested', 'urgent',
    'Operator approval needed — {{kind}}',
    '{{summary}}',
    NULL,
    false, 'migration:0158', 'migration:0158'),
  ('connector.credential.sealed', 'low',
    '{{provider}} credential sealed',
    'A credential was sealed for the {{provider}} connector.',
    NULL,
    false, 'migration:0158', 'migration:0158'),
  ('connector.credential.unsealed', 'low',
    '{{provider}} credential unsealed',
    'The sealed credential for the {{provider}} connector was unsealed or removed.',
    NULL,
    false, 'migration:0158', 'migration:0158'),
  ('connector.models.changed', 'low',
    '{{provider}} model catalog changed',
    'Your usable model catalog may have changed — re-fetch GET /infer/v1/models/usable.',
    NULL,
    false, 'migration:0158', 'migration:0158'),
  ('pay:payment_request-issued', 'normal',
    '{{issuerName}} sent you a payment request',
    '{{issuerName}} is requesting {{totalFormatted}}.',
    '{{issuerName}} is requesting {{totalFormatted}}.',
    false, 'migration:0158', 'migration:0158'),
  ('pay:payment_request-voided', 'normal',
    'Payment request voided',
    '{{totalFormatted}} was voided by the issuer.',
    '{{totalFormatted}} was voided by the issuer.',
    false, 'migration:0158', 'migration:0158'),
  ('pay:payment_request-claimed', 'low',
    'Your counterparty claimed their identity',
    'The recipient of your payment request claimed their identity and can now be reached directly.',
    'The recipient of your payment request claimed their identity and can now be reached directly.',
    false, 'migration:0158', 'migration:0158')
ON CONFLICT (scope) DO NOTHING;
