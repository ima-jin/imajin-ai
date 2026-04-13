-- Stub tracking on profiles
ALTER TABLE profile.profiles ADD COLUMN IF NOT EXISTS claimed_by TEXT;        -- owner DID, null = unclaimed stub
ALTER TABLE profile.profiles ADD COLUMN IF NOT EXISTS claim_status TEXT;       -- 'unclaimed' | 'pending' | 'claimed'

CREATE INDEX IF NOT EXISTS idx_profiles_claim_status ON profile.profiles (claim_status) WHERE claim_status IS NOT NULL;
