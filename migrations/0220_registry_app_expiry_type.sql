-- owner: kernel
-- Mechanical expiry is node-signed; existing app and consent history stays intact.
INSERT INTO auth.attestation_type_registry (type_name, namespace, description)
VALUES ('registry.app.expired', 'platform',
  'Node-signed expiry of a DCR client unconsented for at least 7 days; payload: appId, reason=dcr-unconsented-ttl, ttlDays=7, createdAt.')
ON CONFLICT (type_name) DO NOTHING;
