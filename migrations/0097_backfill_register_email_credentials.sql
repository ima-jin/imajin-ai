-- 0097_backfill_register_email_credentials.sql
-- Issue #1855 — backfill auth.credentials(type='email') rows for identities
-- that were created through the keypair "Create Account" register flow
-- (POST /api/register), which wrote the signup email only to
-- profile.profiles.contact_email and never inserted an auth.credentials
-- row.
--
-- That made register a 7th identity-mint site invisible to
-- resolveOrMintInviteTarget's auth.credentials-only lookup
-- (apps/kernel/src/lib/auth/claimable-stub.ts): when one of these users is
-- later invited by email, the lookup misses and silently mints a new,
-- disconnected stub DID, so at accept time invite.to_did (the phantom
-- stub) never matches the accepter's real session DID ("this invite is not
-- for you").
--
-- Idempotent: only inserts where no auth.credentials(type='email') row
-- already exists for that (did, normalized email) pair; re-running is a
-- no-op once caught up.
--
-- Dedupes: skips any profile whose normalized email already belongs to
-- auth.credentials under a DIFFERENT did. Those are exactly the
-- phantom-stub conflicts this bug produces — a real identity's email
-- colliding with a previously-minted stub (or another real identity) — and
-- must be left for explicit resolution rather than silently clobbered or
-- reassigned by a backfill.
--
-- Left unverified (verified_at NULL), matching the register route's own
-- insert: the keypair register flow never proves ownership of the email,
-- so it should not be represented as a verified credential retroactively.

INSERT INTO auth.credentials (id, did, type, value, verified_at, created_at)
SELECT
  'cred_backfill_' || substr(md5(p.did || ':' || lower(trim(p.contact_email))), 1, 20),
  p.did,
  'email',
  lower(trim(p.contact_email)),
  NULL,
  now()
FROM profile.profiles p
WHERE p.contact_email IS NOT NULL
  AND trim(p.contact_email) <> ''
  -- Identity must actually exist — never manufacture a credentials row
  -- pointing at a missing DID.
  AND EXISTS (SELECT 1 FROM auth.identities i WHERE i.id = p.did)
  -- No credential already represents this exact (did, normalized email)
  -- pair (covers re-running this migration, and any identity that already
  -- got its credential written through another path, e.g. onboard).
  AND NOT EXISTS (
    SELECT 1 FROM auth.credentials c
    WHERE c.did = p.did
      AND c.type = 'email'
      AND c.value = lower(trim(p.contact_email))
  )
  -- Do not create a second identity claim on an email that already belongs
  -- to a different DID's credentials row — the phantom-stub conflict case,
  -- left for explicit resolution rather than clobbered here.
  AND NOT EXISTS (
    SELECT 1 FROM auth.credentials c2
    WHERE c2.type = 'email'
      AND c2.value = lower(trim(p.contact_email))
      AND c2.did <> p.did
  )
ON CONFLICT (type, value) DO NOTHING;
