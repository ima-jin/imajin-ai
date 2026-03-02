> Implementation task for #63

## What to build

### 1. Schema changes (auth + profile)
- Add `identity_tier VARCHAR(10) DEFAULT 'soft'` to profiles table
- Add `did_migrations` table (old_did, new_did, migrated_at)
- Run `drizzle-kit push` for dev

### 2. Auth: soft DID session creation
- `POST /api/session/soft` — create session from email (no keypair needed)
  - Input: `{ email: string, name?: string }`
  - Creates/finds profile with `did:email:user_at_domain.com`, tier=soft
  - Returns session cookie (same format as existing sessions)
- Existing `/api/session` endpoint should return `identity_tier` in response

### 3. Auth middleware update
- `requireAuth()` should work for both soft and hard DIDs
- Add `requireHardDID()` for endpoints that need keypair auth
- Session response includes `tier: 'soft' | 'hard'`

### 4. Profile: tier-aware display
- Profile page shows tier badge (subtle)
- Soft DID profile page: name, email, events attended
- "Upgrade to full profile" CTA for soft DID users

## Files likely touched
- `apps/auth/src/db/schema.ts`
- `apps/profile/src/db/schema.ts`
- `apps/auth/app/api/session/soft/route.ts` (new)
- `apps/auth/src/lib/auth.ts` (middleware)
- `apps/profile/app/[did]/page.tsx`

## Test
- Create soft DID via API, verify session works
- Verify existing hard DID auth still works
- Profile page renders for soft DID
