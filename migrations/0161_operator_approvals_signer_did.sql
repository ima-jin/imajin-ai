-- Migration: 0161_operator_approvals_signer_did
-- owner: kernel
-- #2337: `operator.approval.decided` was only ever addressed to the
-- operator (`subject: operatorDid`), so the agent that raised the
-- proposal never received the decision. Additive only, per
-- migrations/OWNERSHIP.md (kernel owns the `operator` schema):
--
--   signer_did — nullable text, the requesting agent's DID captured from
--                the optional `signerDid` field on the
--                `operator.approval.requested` payload (e.g. `ima-jin/
--                openclaw-imajin-plugin`'s gateway-approvals bridge signs
--                every request with its own agent DID keypair). NULL for
--                a legacy bare-kind request, or any source that omits it
--                — `decideOperatorApproval` then falls back to
--                operator-only delivery, today's behavior.

ALTER TABLE operator.approvals
  ADD COLUMN IF NOT EXISTS signer_did text;
