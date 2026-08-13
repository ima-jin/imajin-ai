-- 0095_invite_context.sql
-- Phase 2 of #1834 (claimable-stub invite context extension).
--
-- Adds the invite-URL context slots the research report on #1833 proposed:
-- `scope_did` (the org/community DID the invitee should land in / join) and
-- `pending_attestation_id` (the record awaiting the invitee's
-- countersignature, e.g. a pre-written vouch or delivery attestation).
--
-- Both stay server-side (#1834 Phase 2 design): the invite URL shape
-- (`/invite/{did}/{code}`) is unchanged, and neither field is ever put in a
-- query string on its own — callers resolve context by looking up the
-- invite row by its opaque `code`.

ALTER TABLE connections.invites
  ADD COLUMN IF NOT EXISTS scope_did text,
  ADD COLUMN IF NOT EXISTS pending_attestation_id text REFERENCES auth.attestations(id);

CREATE INDEX IF NOT EXISTS idx_invites_scope_did ON connections.invites (scope_did);
CREATE INDEX IF NOT EXISTS idx_invites_pending_attestation_id ON connections.invites (pending_attestation_id);

-- Carries the originating invite's code through the onboard-token email
-- round trip (POST /api/onboard -> GET /api/onboard/verify) so verify can
-- re-resolve scope_did/pending_attestation_id from the invite row by code
-- server-side, rather than trusting whatever a client-supplied query
-- param claims at verify time.
ALTER TABLE auth.onboard_tokens
  ADD COLUMN IF NOT EXISTS invite_code text REFERENCES connections.invites(code);

CREATE INDEX IF NOT EXISTS idx_auth_onboard_tokens_invite_code ON auth.onboard_tokens (invite_code);
