# @imajin/auth — Sovereign Identity Package

**Status:** 🟡 Planning  
**Package:** `packages/auth` (library)  
**App:** `apps/auth` (API service → jin.imajin.ai/auth)

---

## Overview

Pluggable authentication for the Imajin ecosystem. Supports humans and agents. Every interaction is signed and attributable.

**Philosophy:**
- Auth should be simple: prove you control a key
- No passwords, no OAuth redirect hell
- Pluggable backends (start simple, add complexity only if needed)
- Works for humans AND agents (same primitives)
- Every message is signed and typed (human/agent)

---

## Core Concepts

### Identity Types
```typescript
type IdentityType = 'human' | 'agent';

interface Identity {
  id: string;              // did:imajin:xxx or legacy ID
  type: IdentityType;
  publicKey: string;       // Ed25519 public key
  metadata?: {
    name?: string;
    avatar?: string;
    capabilities?: string[];  // for agents
  };
}
```

### Signed Messages
Every request/message in the system:
```typescript
interface SignedMessage {
  from: string;            // Identity ID
  type: IdentityType;      // 'human' | 'agent'
  timestamp: number;       // Unix ms
  payload: any;            // The actual content
  signature: string;       // Ed25519 signature of above
}
```

### Verification
```typescript
// Simple: does this signature match this public key?
function verify(message: SignedMessage, publicKey: string): boolean
```

---

## Architecture

### Package (`packages/auth`)
Shared library — imported by apps, not deployed.

```
packages/auth/
├── src/
│   ├── index.ts              # Public exports
│   ├── types.ts              # Identity, SignedMessage, etc.
│   ├── sign.ts               # Signing utilities
│   ├── verify.ts             # Verification utilities
│   ├── providers/
│   │   ├── index.ts
│   │   ├── keypair.ts        # Simple Ed25519 (default)
│   │   ├── kratos.ts         # Ory Kratos (existing)
│   │   └── passkey.ts        # WebAuthn (future)
│   └── middleware/
│       ├── nextjs.ts         # Next.js middleware
│       └── express.ts        # Express middleware
├── package.json
└── PROJECTS.md
```

### App (`apps/auth`)
API service — deployed to Vercel as jin.imajin.ai/auth.

```
apps/auth/
├── app/
│   ├── page.tsx              # Landing / docs
│   ├── api/
│   │   ├── register/route.ts # Create new identity
│   │   ├── verify/route.ts   # Verify a signed message
│   │   ├── lookup/route.ts   # Get identity by ID
│   │   └── challenge/route.ts # Get challenge for signing
│   └── [...catchall]/page.tsx
├── package.json
└── PROJECTS.md
```

---

## Providers

### 1. Keypair (Default)
Simplest possible auth. User has a keypair, signs messages.

**Pros:** No server state, works offline, simple  
**Cons:** Key management is on user

```typescript
import { generateKeypair, sign, verify } from '@imajin/auth/keypair';

const { publicKey, privateKey } = generateKeypair();
const signature = sign(message, privateKey);
const valid = verify(message, signature, publicKey);
```

### 2. Kratos (Existing)
Full identity management with Ory Kratos.

**Pros:** Email/password, MFA, account recovery, admin UI  
**Cons:** Requires Kratos server, more complex

```typescript
import { KratosProvider } from '@imajin/auth/kratos';
// Wraps existing imajin-web/lib/auth code
```

### 3. Passkey (Future)
WebAuthn/passkeys for passwordless browser auth.

**Pros:** Phishing-resistant, device-bound, UX is good  
**Cons:** Browser-only, device-specific

---

## API Endpoints (apps/auth)

### POST /api/register
Create new identity.
```typescript
// Request
{ name?: string, type: 'human' | 'agent', publicKey: string }

// Response
{ id: 'did:imajin:xxx', created: true }
```

### POST /api/verify
Verify a signed message.
```typescript
// Request
{ message: SignedMessage }

// Response
{ valid: boolean, identity?: Identity }
```

### GET /api/lookup/:id
Get identity by ID.
```typescript
// Response
{ identity: Identity } | { error: 'not found' }
```

### POST /api/challenge
Get a challenge to sign (for login flows).
```typescript
// Request
{ identityId: string }

// Response
{ challenge: string, expiresAt: number }
```

---

## Database Schema

```sql
-- Identities table
CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY,              -- did:imajin:xxx
  type TEXT NOT NULL,               -- 'human' | 'agent'
  public_key TEXT NOT NULL UNIQUE,
  name TEXT,
  avatar_url TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- For agents: capabilities
CREATE TABLE auth_agent_capabilities (
  identity_id TEXT REFERENCES auth_identities(id),
  capability TEXT NOT NULL,
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  granted_by TEXT REFERENCES auth_identities(id),
  PRIMARY KEY (identity_id, capability)
);

-- Challenge tokens (for login flows)
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY,
  identity_id TEXT REFERENCES auth_identities(id),
  challenge TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
```

---

## Usage in Apps

### Verifying requests (server-side)
```typescript
import { verifyRequest } from '@imajin/auth/middleware/nextjs';

export async function POST(request: Request) {
  const { identity, valid } = await verifyRequest(request);
  
  if (!valid) {
    return Response.json({ error: 'Invalid signature' }, { status: 401 });
  }
  
  // identity.id, identity.type available
  console.log(`Request from ${identity.type}: ${identity.id}`);
}
```

### Signing requests (client-side)
```typescript
import { signRequest } from '@imajin/auth';

const response = await signRequest('/api/something', {
  method: 'POST',
  body: { data: 'whatever' },
}, privateKey);
```

---

## Migration from Kratos

Existing imajin-web Kratos users:
1. Keep Kratos running for existing sessions
2. Generate keypair for each Kratos identity
3. Store public key in identity metadata
4. Gradually migrate to signature-based auth
5. Kratos becomes optional session layer, not required

---

## Deployment

### Package
```bash
# Build
pnpm --filter @imajin/auth build
```

### App
Deployed via GitHub Actions to imajin-server (self-hosted).
- Push to `main` → auto-deploy to dev (`dev-auth`, port 3001)
- Push `v*` tag → deploy to prod (`auth`, port 7001)

Domain: `jin.imajin.ai/auth`

---

## TODO

- [ ] Define TypeScript types (Identity, SignedMessage)
- [ ] Implement Ed25519 keypair provider
- [ ] Create sign/verify utilities
- [ ] Build Next.js middleware
- [ ] Extract Kratos provider from imajin-web
- [ ] Create apps/auth API routes
- [ ] Database schema + Drizzle setup
- [ ] Landing page for jin.imajin.ai/auth
- [ ] Documentation / developer guide

---

## Dependencies

```json
{
  "@noble/ed25519": "^2.0.0",  // Ed25519 signing
  "drizzle-orm": "^0.45.1",    // Database
  "postgres": "^3.4.0"         // postgres-js driver
}
```

---

## Notes

> "Auth is so over engineered rn. There has to be an easier way."

This is the easier way. A keypair and a signature. That's it.

Everything else (OAuth, sessions, tokens, refresh flows) is optional complexity you add *if you need it*, not by default.
