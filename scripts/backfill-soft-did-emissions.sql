-- Backfill: Find soft DIDs that were created but never received the identity.created MJN emission.
-- Run against imajin_prod. This is a READ-ONLY query to identify who needs backfill.
-- Actual emission is kernel-internal: use the in-process emission executor after operator review.

-- Step 1: Find soft DIDs with 0 MJN credits (missed identity.created emission)
SELECT 
  i.id as did,
  i.name,
  i.contact_email,
  i.created_at,
  COALESCE(b.credit_amount, 0) as mjn_credits
FROM auth.identities i
LEFT JOIN pay.balances b ON b.did = i.id AND b.currency = 'MJN'
WHERE i.subtype = 'human'
  AND i.scope = 'actor'
  AND COALESCE(b.credit_amount, 0) = 0
  AND i.created_at > '2026-01-01'
ORDER BY i.created_at DESC;

-- Step 2: After confirming the list, arrange a reviewed kernel-internal backfill.
-- HTTP emission ingress is closed (#2735); no shared bearer key can authorize it.
