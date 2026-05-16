-- Create reverse membership records: agent is a delegated member of human's identity
INSERT INTO auth.identity_members (identity_did, member_did, role, added_by, added_at)
SELECT im.member_did, im.identity_did, 'agent', im.member_did, NOW()
FROM auth.identity_members im
JOIN auth.identities i ON i.id = im.identity_did
WHERE i.subtype = 'agent' AND im.role = 'owner' AND im.removed_at IS NULL
ON CONFLICT DO NOTHING;
