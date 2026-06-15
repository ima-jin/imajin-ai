-- Backfill: Find soft DIDs that were created but never received the identity.created MJN emission.
-- Run against imajin_prod. This is a READ-ONLY query to identify who needs backfill.
-- The actual emission must go through the /pay/api/emission endpoint.

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

-- Step 2: After confirming the list, use the API to emit 10 MJN to each:
-- curl -X POST http://localhost:7000/pay/api/emission \
--   -H "Content-Type: application/json" \
--   -H "Authorization: Bearer $PAY_SERVICE_API_KEY" \
--   -d '{"to_did":"DID_HERE","amount":10,"currency":"MJN","reason":"Welcome to the network (backfill)","metadata":{"attestation_type":"identity.created","to_role":"subject","event_type":"identity.created","backfill":true}}'
