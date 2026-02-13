# auth.imajin.ai — Sovereign Identity Service

**Status:** 🟡 Planning  
**Domain:** auth.imajin.ai  
**Stack:** Next.js 14, Tailwind, Drizzle, Neon Postgres

---

## Overview

Central identity service for the Imajin ecosystem. Register identities, verify signatures, issue tokens.

**What it does:**
- Register human and agent identities (public keys → DIDs)
- Issue challenges for authentication
- Verify signed challenges and issue tokens
- Validate tokens for other apps
- Lookup identity metadata

**What it doesn't do:**
- Store passwords (there are none)
- Manage sessions (apps do that)
- OAuth flows (we're simpler than that)

---

## Authentication Flow

### 1. Registration
Client registers a public key, gets a DID.

```
POST /api/register
{
  "publicKey": "abc123...",  // Ed25519 public key (hex)
  "type": "human" | "agent",
  "name": "Jin",             // optional
  "metadata": {}             // optional
}

Response:
{
  "id": "did:imajin:abc123",
  "type": "agent",
  "created": true
}
```

### 2. Challenge
Client requests a challenge to sign.

```
POST /api/challenge
{
  "id": "did:imajin:abc123"
}

Response:
{
  "challenge": "random-string-xyz",
  "expiresAt": "2026-02-13T22:00:00Z"
}
```

### 3. Authenticate
Client signs the challenge, gets a token.

```
POST /api/authenticate
{
  "id": "did:imajin:abc123",
  "challenge": "random-string-xyz",
  "signature": "signed-challenge-hex"
}

Response:
{
  "token": "imajin_tok_xxx",
  "expiresAt": "2026-02-14T16:30:00Z",
  "identity": {
    "id": "did:imajin:abc123",
    "type": "agent",
    "name": "Jin"
  }
}
```

### 4. Validate (for apps)
Apps validate tokens against auth service.

```
POST /api/validate
{
  "token": "imajin_tok_xxx"
}

Response:
{
  "valid": true,
  "identity": {
    "id": "did:imajin:abc123",
    "type": "agent",
    "name": "Jin"
  }
}
```

### 5. Verify Signature (stateless option)
Apps can skip tokens and verify signatures directly.

```
POST /api/verify
{
  "message": {
    "from": "did:imajin:abc123",
    "type": "agent",
    "timestamp": 1707850800000,
    "payload": { ... },
    "signature": "..."
  }
}

Response:
{
  "valid": true,
  "identity": { ... }
}
```

---

## Architecture

```
apps/auth/
├── app/
│   ├── page.tsx                    # Landing page / docs
│   ├── layout.tsx
│   ├── globals.css
│   └── api/
│       ├── register/route.ts       # POST: register identity
│       ├── challenge/route.ts      # POST: get challenge
│       ├── authenticate/route.ts   # POST: sign challenge → token
│       ├── validate/route.ts       # POST: validate token
│       ├── verify/route.ts         # POST: verify signature
│       └── lookup/
│           └── [id]/route.ts       # GET: lookup identity
├── src/
│   └── db/
│       ├── schema.ts
│       └── index.ts
├── package.json
├── drizzle.config.ts
└── PROJECTS.md
```

---

## Database Schema

```sql
-- Identities
CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY,                    -- did:imajin:xxx
  type TEXT NOT NULL CHECK (type IN ('human', 'agent')),
  public_key TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Challenges (short-lived, for auth flow)
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  identity_id TEXT REFERENCES auth_identities(id),
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,                    -- NULL until used
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tokens (issued after successful auth)
CREATE TABLE auth_tokens (
  id TEXT PRIMARY KEY,                    -- imajin_tok_xxx
  identity_id TEXT REFERENCES auth_identities(id) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,                 -- NULL unless revoked
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

-- Indexes
CREATE INDEX idx_auth_tokens_identity ON auth_tokens(identity_id);
CREATE INDEX idx_auth_challenges_expires ON auth_challenges(expires_at);
```

---

## Token Format

Simple opaque tokens:
```
imajin_tok_[random-32-bytes-hex]
```

Example: `imajin_tok_a1b2c3d4e5f6...`

**Why opaque tokens (not JWTs)?**
- Simpler to revoke (just delete from DB)
- No signature verification needed on every request
- Validation is a single DB lookup
- Less footgun potential (JWT alg confusion, key management)

If we need stateless validation later, we can add JWT support.

---

## Security

### Rate Limiting
- `/api/register`: 10/hour per IP
- `/api/challenge`: 20/hour per identity
- `/api/authenticate`: 5/minute per identity (prevent brute force)
- `/api/validate`: 1000/minute per app (apps call this a lot)

### Token Expiry
- Default: 24 hours
- Configurable per identity type
- Tokens auto-expire, no refresh flow (just re-authenticate)

### Challenge Expiry
- 5 minutes
- Single use (marked used_at on success)

---

## Landing Page

Simple page at auth.imajin.ai:
- What is this?
- How to register
- API docs
- Link to packages/auth for client libraries

---

## Client Usage

### With @imajin/auth package
```typescript
import { ImajinAuth } from '@imajin/auth';

const auth = new ImajinAuth({
  endpoint: 'https://auth.imajin.ai',
  privateKey: process.env.IMAJIN_PRIVATE_KEY,
});

// Register (first time)
const identity = await auth.register({
  type: 'agent',
  name: 'My Bot',
});

// Authenticate (get token)
const { token } = await auth.authenticate();

// Use token in requests
fetch('https://api.example.com', {
  headers: {
    'Authorization': `Bearer ${token}`,
  },
});
```

### With raw HTTP
```bash
# Register
curl -X POST https://auth.imajin.ai/api/register \
  -H "Content-Type: application/json" \
  -d '{"publicKey": "...", "type": "human", "name": "Ryan"}'

# Get challenge
curl -X POST https://auth.imajin.ai/api/challenge \
  -H "Content-Type: application/json" \
  -d '{"id": "did:imajin:xxx"}'

# Authenticate (after signing challenge locally)
curl -X POST https://auth.imajin.ai/api/authenticate \
  -H "Content-Type: application/json" \
  -d '{"id": "did:imajin:xxx", "challenge": "...", "signature": "..."}'
```

---

## TODO

- [ ] Create API routes
- [ ] Database schema + Drizzle setup
- [ ] Ed25519 signature verification
- [ ] Token generation/validation
- [ ] Rate limiting middleware
- [ ] Landing page with docs
- [ ] Client library in packages/auth

---

## Notes

> "Auth is so over engineered rn."

This is the simpler way:
1. You have a keypair
2. You sign a challenge
3. You get a token
4. Apps validate the token

No passwords. No OAuth. No email verification (optional, not required).
Just cryptographic proof that you control a key.
