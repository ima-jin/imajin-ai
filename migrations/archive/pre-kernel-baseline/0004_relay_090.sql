-- DFOS 0.9.0: add GIN index on relay_public_credentials.att for efficient
-- resource-filtered queries (getPublicCredentials uses jsonb containment @>)
CREATE INDEX IF NOT EXISTS "idx_relay_public_credentials_att" ON "relay"."relay_public_credentials" USING gin ("att");
