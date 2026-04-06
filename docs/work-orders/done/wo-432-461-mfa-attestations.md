# Work Order: MFA + Device Tracking + Attestation Chains

**Issues:** #432, #461, #306
**Priority:** High — trust infrastructure for April 1
**Estimated effort:** 2-3 days

---

## Part 1: MFA / Stored Keys (#432)

### Goal

Server-side encrypted key storage as an alternative login method. Currently, keypair users must have their private key in localStorage. Stored keys let the server hold an encrypted copy, unlockable via passphrase, TOTP, or device auth.

### Schema Changes

```sql
-- auth.stored_keys: encrypted private keys
CREATE TABLE auth.stored_keys (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL REFERENCES auth.identities(id),
  encrypted_key TEXT NOT NULL,          -- AES-256-GCM encrypted private key
  salt TEXT NOT NULL,                    -- PBKDF2 salt
  key_derivation TEXT NOT NULL DEFAULT 'pbkdf2',  -- derivation method
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  device_fingerprint TEXT,              -- optional device binding
  UNIQUE(did)                           -- one stored key per DID for now
);

-- auth.mfa_methods: registered MFA methods per identity
CREATE TABLE auth.mfa_methods (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL REFERENCES auth.identities(id),
  type TEXT NOT NULL,                   -- 'totp', 'passkey', 'recovery_code'
  secret TEXT,                          -- encrypted TOTP secret or passkey credential
  name TEXT,                            -- user-facing label ("Authenticator app", "YubiKey")
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

-- auth.devices: known devices per identity
CREATE TABLE auth.devices (
  id TEXT PRIMARY KEY,
  did TEXT NOT NULL REFERENCES auth.identities(id),
  fingerprint TEXT NOT NULL,            -- browser/device fingerprint
  name TEXT,                            -- "Chrome on MacBook", auto-detected
  ip TEXT,
  user_agent TEXT,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  trusted BOOLEAN DEFAULT FALSE,        -- user-marked trusted
  UNIQUE(did, fingerprint)
);
```

### API Endpoints

```
POST /api/keys/store          — encrypt and store private key
POST /api/keys/retrieve       — decrypt and return (requires MFA)
DELETE /api/keys/stored        — remove stored key

POST /api/mfa/totp/setup      — generate TOTP secret, return QR
POST /api/mfa/totp/verify     — verify TOTP code, activate
POST /api/mfa/totp/challenge  — verify code during login

GET  /api/devices             — list known devices
POST /api/devices/trust       — mark device as trusted
DELETE /api/devices/:id       — remove device

GET  /api/session             — add device info to session response
```

### Login Flow with Stored Keys

```
1. User enters email/DID on login page
2. Server checks: has stored key? has MFA?
3. If stored key + MFA:
   a. Prompt for passphrase + TOTP
   b. Server decrypts key with derived passphrase key
   c. Server signs session token with decrypted key
   d. Key never sent to client (server-side signing)
4. If new device detected:
   a. Log in auth.devices
   b. Emit session.new_device attestation
   c. (Future: email/push alert via #260)
```

### Key Security Principles

- Private key encrypted client-side with passphrase before sending to server
- Server never sees plaintext private key
- PBKDF2 with 600k iterations for key derivation
- AES-256-GCM for encryption
- Stored key is useless without passphrase
- MFA required to retrieve/use stored key

### Files to Create/Modify

- `apps/auth/app/api/keys/store/route.ts` — new
- `apps/auth/app/api/keys/retrieve/route.ts` — new
- `apps/auth/app/api/mfa/totp/setup/route.ts` — new
- `apps/auth/app/api/mfa/totp/verify/route.ts` — new
- `apps/auth/app/api/mfa/totp/challenge/route.ts` — new
- `apps/auth/app/api/devices/route.ts` — new
- `apps/auth/app/api/session/route.ts` — add device info
- `apps/auth/src/db/schema.ts` — add tables
- `packages/db/src/schema/auth.ts` — add drizzle schemas
- Auth UI components for MFA setup flow

### Dependencies

- `otplib` — TOTP generation/verification
- `qrcode` — QR code for authenticator apps
- No new infrastructure needed

---

## Part 2: Attestation Chain Coverage (#461)

### Goal

Emit attestations at every trust-relevant seam across all services. The attestation chain is the backbone of the trust graph — gaps mean the standing computation is incomplete.

### Current State (6 live types)

| Type | Service | Trigger |
|------|---------|---------|
| `transaction.settled` | pay | Successful .fair settlement |
| `customer` | pay | First transaction with a service |
| `connection.invited` | connections | Invite extended |
| `connection.accepted` | connections | Invite accepted |
| `vouch` | connections | Inviter sponsors acceptee |
| `session.created` | auth | Login event |

### New Attestations — Priority Order

#### Batch 1: Events (before April 1)

| Type | Service | Trigger | Bilateral? |
|------|---------|---------|------------|
| `ticket.purchased` | events | Ticket purchase webhook | Yes — event DID + buyer DID |
| `event.attended` | events | Check-in (QR scan) | Yes — event DID + attendee DID |
| `event.created` | events | New event created | No — creator DID only |
| `cohost.added` | events | Cohost joins event | Yes — event DID + cohost DID |

**Implementation:** Add attestation calls in:
- `apps/events/app/api/webhook/payment/route.ts` — after ticket creation
- `apps/events/app/api/events/[id]/tickets/[ticketId]/check-in/route.ts` — after check-in
- `apps/events/app/api/events/route.ts` — after event creation
- `apps/events/app/api/events/[id]/cohosts/route.ts` — after cohost added

#### Batch 2: Identity (after April 1)

| Type | Service | Trigger |
|------|---------|---------|
| `profile.verified` | profile | Email/phone verified |
| `handle.claimed` | profile | Handle set |
| `session.new_device` | auth | Login from unknown device |

#### Batch 3: Commerce (after April 1)

| Type | Service | Trigger |
|------|---------|---------|
| `listing.created` | market | Seller creates listing |
| `listing.purchased` | market | Buyer purchases |

#### Batch 4: Social (later)

| Type | Service | Trigger |
|------|---------|---------|
| `message.first` | chat | First message in conversation |
| `pod.created` | connections | New pod created |
| `pod.joined` | connections | Member added |
| `course.enrolled` | learn | Enrollment |
| `node.registered` | registry | DFOS node registration |

### Attestation Helper

Create a shared utility so every service emits attestations the same way:

```typescript
// packages/auth/src/attestation.ts
export async function emitAttestation(params: {
  type: string;
  fromDid: string;
  toDid?: string;           // for bilateral
  context: Record<string, unknown>;
  bilateral?: boolean;
}): Promise<void> {
  // POST to auth service internal API
  // Auth service stores in auth.attestations
  // If bilateral, creates countersignature request
}
```

**Files:**
- `packages/auth/src/attestation.ts` — new shared utility
- `apps/auth/app/api/attestations/emit/route.ts` — internal API endpoint
- Each service calls `emitAttestation()` at the appropriate trigger point

### Design Rules

1. Every attestation signed by the emitting service's DID (or actor's DID)
2. Stored in `auth.attestations`
3. Bilateral where both parties are active (purchases, check-ins, connections)
4. Non-fatal — attestation failure should never block the primary action (try/catch)
5. Include contextual metadata (event ID, ticket ID, amount, etc.)

---

## Part 3: Device Tracking (#306)

Folded into Part 1 (MFA). The `auth.devices` table and fingerprinting logic is part of the MFA implementation. New device detection triggers a `session.new_device` attestation (Part 2, Batch 2).

---

## Execution Order

1. **Schema changes** — add all three tables in one migration
2. **Device tracking** — simplest, immediate value (log devices on every session)
3. **TOTP MFA** — setup flow, verify flow, challenge during login
4. **Stored keys** — encrypt/store/retrieve with MFA gate
5. **Attestation helper** — shared utility + internal API
6. **Batch 1 attestations** — events service (4 attestation types)
7. **Remaining batches** — post-April 1

## Verification

```bash
# MFA
curl -X POST https://jin.imajin.ai/auth/api/mfa/totp/setup  # returns QR + secret
curl -X POST https://jin.imajin.ai/auth/api/mfa/totp/verify  # activates with code

# Devices
curl https://jin.imajin.ai/auth/api/devices  # lists known devices

# Attestations
# Buy a ticket, verify attestation appears:
ssh jin@192.168.1.193 "PGPASSWORD=... psql ... -c \"
  SELECT type, from_did, to_did, created_at 
  FROM auth.attestations 
  ORDER BY created_at DESC LIMIT 5;
\""
```
