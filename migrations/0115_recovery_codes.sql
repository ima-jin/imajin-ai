-- 0115_recovery_codes.sql
-- Recovery codes — the self-custody key-recovery floor (#1250 Phase 1).
--
-- Makes the previously-dead `recovery_code` mfa_methods.type enum value real:
-- rather than overload that table's one-row-per-method shape (built for a
-- single reversibly-encrypted TOTP/email secret), recovery codes get their
-- own table because there are N one-time, one-way-hashed codes per identity
-- generated together as a batch.
--
-- auth.recovery_codes — one row per one-time code.
--   code_hash is a self-describing scrypt hash (`scrypt$N$r$p$saltHex$hashHex`)
--   of the normalised (dash-stripped, upper-cased) code. Never the plaintext.
--   A code is active when both used_at and invalidated_at are NULL.
--   - used_at:        stamped when this exact code redeems a recovery (single-use).
--   - invalidated_at: stamped on bulk invalidation — regeneration or any
--                      key rotation (recovery-authorized or the existing
--                      #401 client-signed rotate/keys endpoints) invalidates
--                      every code in the identity's active set at once.
--
-- auth.recovery_attempts — append-only audit trail of every verification
-- attempt (success or failure), per the anti-takeover requirement that
-- recovery — the account-takeover surface — leaves a queryable record of
-- who tried what, when. Deliberately has no FK to auth.identities: a bad or
-- unknown DID in the request body must still produce an auditable row.

CREATE TABLE IF NOT EXISTS auth.recovery_codes (
  id             TEXT        NOT NULL PRIMARY KEY,             -- rc_{nanoid}
  did            TEXT        NOT NULL REFERENCES auth.identities(id),
  code_hash      TEXT        NOT NULL,                         -- scrypt$N$r$p$salt$hash — never plaintext
  used_at        TIMESTAMPTZ,                                  -- single-use: set on redemption
  invalidated_at TIMESTAMPTZ,                                  -- set on regeneration or any rotation
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recovery_codes_did
  ON auth.recovery_codes (did);

-- Fast "load the active set for this DID" lookup at verification time.
CREATE INDEX IF NOT EXISTS idx_recovery_codes_active
  ON auth.recovery_codes (did)
  WHERE used_at IS NULL AND invalidated_at IS NULL;

CREATE TABLE IF NOT EXISTS auth.recovery_attempts (
  id         TEXT        NOT NULL PRIMARY KEY,   -- ratt_{nanoid}
  did        TEXT        NOT NULL,               -- no FK — an attempt against an unknown DID must still audit
  ip         TEXT        NOT NULL,
  outcome    TEXT        NOT NULL,               -- 'success' | 'invalid_code' | 'no_active_codes' | 'not_self_custody' | 'identity_not_found' | 'invalid_public_key' | 'public_key_conflict' | 'rate_limited'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recovery_attempts_did
  ON auth.recovery_attempts (did, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_recovery_attempts_ip
  ON auth.recovery_attempts (ip, created_at DESC);
