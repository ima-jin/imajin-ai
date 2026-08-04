-- 0081_vault_grant_request_custody_pair.sql
-- Carry the custody pair (subject, granted_to) on Tier 1 grant requests (#1603).
--
-- ## Why
--
-- 0075 built the Tier 1 handshake for exactly one custody shape: the node's
-- self-grant, where subject = granted_to = the node's own DID. Those two values
-- were therefore implicit and the table never recorded them — the owner agent
-- reconstructed them from its own config (ownerDid + nodeDid).
--
-- Static-secret custody (#1439, Option B) is deliberately a different shape:
--
--   subject    = principalDid  -- the human who owns the credential
--   granted_to = granteeDid    -- the connector app DID, e.g. did:imajin:warp-connector
--
-- With the pair unrecorded there is no way for the node to tell the owner agent
-- which grant to sign, and no node-written state for
-- POST /api/vault/delegation/grant to check the returned grant against. The
-- endpoint currently falls back to asserting granted_to == this node's DID, which
-- is precisely the assumption that makes per-DID connector credentials
-- unpromotable to Tier 1.
--
-- ## Backfill
--
-- Existing rows are all self-grant requests by construction (nothing else could
-- have written one), so backfilling both columns from the node's DID is exact,
-- not a guess. The node DID is not available to SQL, so the columns are added
-- nullable and NULL is read as "self-grant" by the application — see
-- resolveHandshake. That keeps any in-flight request from 0075 fulfillable
-- across the deploy.

ALTER TABLE kernel.vault_grant_requests
  ADD COLUMN IF NOT EXISTS subject TEXT;

ALTER TABLE kernel.vault_grant_requests
  ADD COLUMN IF NOT EXISTS granted_to TEXT;

COMMENT ON COLUMN kernel.vault_grant_requests.subject IS
  'DID granting access (principalDid for static secrets, node DID for a self-grant). NULL on pre-#1603 rows, read as the node DID.';

COMMENT ON COLUMN kernel.vault_grant_requests.granted_to IS
  'DID receiving access (connector app DID for static secrets, node DID for a self-grant). NULL on pre-#1603 rows, read as the node DID. NOT the ECDH recipient — the field key is always wrapped to node_x_pub.';

-- Lets the owner agent's poll filter by grantee without a scan once multiple
-- connector DIDs are in play.
CREATE INDEX IF NOT EXISTS idx_vault_grant_requests_granted_to
  ON kernel.vault_grant_requests (granted_to, status);
