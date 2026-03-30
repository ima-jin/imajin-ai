# RFC-22: Federated Authentication

**Status:** Draft
**Author:** Ryan Veteze
**Date:** 2026-03-30

---

## Summary

A protocol for authenticating users across federated Imajin/DFOS nodes without exposing private keys to foreign services. The user authenticates on their home relay, receives a signed attestation, and presents it to the requesting service. Private keys never leave the user's trust boundary.

## Problem

With peered relays (ATX, NYC, LIS, Imajin), a user registered on one relay should be able to authenticate on another. The naive approach — "enter your DID and sign a challenge" — requires the user to input their private key into a foreign service's UI. This fundamentally breaks the sovereignty model.

Users will not (and should not) paste private keys into sites they don't control. We need a redirect-based flow where authentication happens on the user's home turf.

## Prior Art

| Protocol | How it works | Limitation |
|----------|-------------|------------|
| OAuth 2.0 / OIDC | Redirect to IdP → authenticate → callback with token | Centralized IdP, not self-sovereign |
| SIWE (Sign-In with Ethereum) | User signs a message in their wallet | Requires wallet browser extension |
| DIDComm | Peer-to-peer encrypted messaging between DIDs | Complex, not designed for web auth |
| Fediverse (ActivityPub) | HTTP Signatures on server-to-server requests | Server-to-server only, no user-facing auth |

DFOS federated auth is closest to OAuth in UX but closest to SIWE in trust model — the user proves key possession, but they do it on their own infrastructure.

## Protocol

### Actors

| Actor | Role |
|-------|------|
| **User** | Holds private key, has a home relay |
| **Home Relay** | The relay where the user's identity chain lives. Trusted by the user. |
| **Requesting Service** | The Imajin node the user wants to access (e.g., events.imajin.ai) |
| **Requesting Relay** | The relay peered with the requesting service. May or may not be the same as the home relay. |

### Three Authentication Tiers

| Tier | User type | Has keys? | Flow | Trust requirement on node |
|------|-----------|-----------|------|--------------------------|
| **1. Direct key auth** | Imajin user on verified node | Yes | Sign challenge on requesting service | Conformant + approved build |
| **2. Home node redirect** | Imajin user on unverified/private node | Yes | Redirect to home node, key stays there | Peered |
| **3. Home relay redirect** | DFOS platform user OR tier 2 fallback | No (custodial) | Redirect to home relay, relay authenticates | Peered |

**Tier 1** is the fast path — user signs directly, like existing Imajin login. Only allowed between nodes running the conformance suite with an approved build. The requesting service trusts the node's software to handle the key safely.

**Tier 2** is for Imajin users whose home node isn't fully verified. Their key stays on their own infrastructure. The requesting service doesn't trust the node enough for direct key handling, but trusts it to produce a valid attestation.

**Tier 3** is for DFOS platform users who never touch their keys (custodied in AWS KMS). Also the fallback for any case where the user can't sign directly.

### Universal Login Flow (Email-Based)

Users don't know their DIDs. They know their email. The login flow starts with email, not a DID:

```
1. User visits requesting service, clicks "Login with DFOS" or "Login from another node"

2. User enters their EMAIL ADDRESS
   — Not a DID. Nobody types did:dfos:7v4vtfnh7v28ka7af3cv79 into a login box.

3. Requesting service resolves email → DID → home relay:
   → Query known peered relays: "who owns user@example.com?"
   → A relay claims it, returns the DID and home relay URL
   → If no relay claims it: "No account found for this email"

4. Requesting service determines auth tier:
   → Imajin user + verified home node? → Tier 1 (direct key auth)
   → Imajin user + unverified home node? → Tier 2 (redirect to home node)
   → DFOS platform user? → Tier 3 (redirect to home relay)

5a. TIER 1 — Direct key auth:
   → Requesting service issues challenge
   → User signs challenge locally (key in browser / key file)
   → Verify signature against chain key
   → Session created

5b. TIER 2 — Home node redirect:
   → Redirect to home node auth endpoint:
     GET https://home-node.example.com/auth/federated
       ?did=did:imajin:abc123
       &callback=https://requesting-service.example.com/auth/callback
       &challenge=<random-nonce>
       &requesting_did=<requesting-service-relay-DID>
   → User authenticates on home node (password, stored key, etc.)
   → Home node signs attestation
   → Redirect back with attestation
   → Verify + session

5c. TIER 3 — Home relay redirect:
   → Redirect to home relay auth endpoint:
     GET https://home-relay.example.com/auth/federated
       ?did=did:dfos:xyz789
       &callback=https://requesting-service.example.com/auth/callback
       &challenge=<random-nonce>
       &requesting_did=<requesting-service-relay-DID>
   → Home relay authenticates user (email code, password, KMS-backed signing)
   → Home relay signs attestation
   → Redirect back with attestation
   → Verify + session

6. Requesting service verifies (for tiers 2 & 3):
   a. Decode JWS, extract signer DID from header
   b. Look up signer's identity chain on own relay (must be peered)
   c. Verify JWS signature against signer's public key
   d. Verify challenge matches what was issued
   e. Verify audience matches own DID
   f. Verify timestamp is within acceptable window
   g. Verify expiresAt has not passed
   h. Verify signer is trusted (peered + conformant for tier, see trust model)

7. Requesting service creates a local session for the user
   — Auto-creates local identity if first visit (from chain state)
   — Returns session token / sets cookie
```

### Email Resolution

The email → DID lookup requires relays/nodes to expose a resolution endpoint:

```
GET /auth/resolve?email=user@example.com
→ { did: "did:dfos:abc123", homeRelay: "https://relay.example.com" }
```

- **Imajin nodes:** Profile data includes email. Resolution is straightforward.
- **DFOS platform:** Email → DID mapping is in the closed-source platform layer. Requires Brandon to expose an API (or proxy through the relay).
- **Privacy:** The resolve endpoint should be rate-limited and may require the requesting service to identify itself (mutual auth). You don't want arbitrary email enumeration.

### Sequence Diagram (Tier 2/3 — Redirect Flow)

```
User            Home Relay/Node      Requesting Service
 │                 │                        │
 │  1. Enter email                          │
 │─────────────────────────────────────────>│
 │                 │  2. Resolve email→DID   │
 │                 │<──────────────────────│
 │                 │  3. Return DID + URL    │
 │                 │──────────────────────>│
 │                 │  4. Redirect to home    │
 │<────────────────────────────────────────│
 │  5. Authenticate│locally                 │
 │────────────────>│                        │
 │                 │  6. Sign attestation    │
 │                 │                        │
 │  7. Redirect back with attestation       │
 │<───────────────│                        │
 │─────────────────────────────────────────>│
 │                 │    8. Verify + session  │
 │<────────────────────────────────────────│
 │                 │                        │
```

## Key Custody Tiers

Different platforms handle private keys differently. The federated auth protocol must work across all of them.

| Platform | Key custody | Who signs | Example |
|----------|-----------|-----------|---------|
| **Custodial** | Platform holds keys (e.g., AWS KMS) | Relay signs on behalf of user | DFOS platform |
| **Stored key** | Browser, password-encrypted | User signs locally | Imajin (password login) |
| **Self-custody** | User's own key file | User signs with raw key | Imajin (key import) |
| **Local-first** | SQLite on user's device | User signs on own hardware | Future DFOS Go binary |

### How each tier produces an attestation

**Custodial (relay-signed):**
1. User authenticates to home relay (email code, password, etc.)
2. Relay accesses user's key via KMS
3. Relay signs the attestation with user's custodied key (or relay's own key)
4. User never interacts with cryptographic material

**Self-sovereign (user-signed):**
1. User authenticates on home relay (password decrypts stored key, or key file loaded)
2. User's client signs the challenge directly
3. Home relay countersigns (wraps in attestation)
4. Both signatures included — stronger proof

**The requesting service doesn't care which tier.** It verifies the attestation signature against a key it can resolve from the chain. Whether that key was accessed via KMS, decrypted from browser storage, or loaded from a hardware device is the home relay's business. The attestation format is identical.

### Implications

- Custodial relays are functionally OAuth identity providers — the relay vouches for the user
- Self-sovereign users provide cryptographic proof — the relay witnesses it
- A requesting service MAY distinguish between tiers (e.g., require self-sovereign for high-value operations) via the optional `authMethod` field in the attestation
- The custodial layer at DFOS is closed-source (AWS KMS) — the trust model must be attestation-based, not implementation-based

## Trust Model

The requesting service does NOT trust the user directly. It trusts the **home relay**, which vouches for the user.

Trust chain:
```
Requesting service trusts home relay
  ← because: peered, conformant (RFC-21), identity chain verified
Home relay trusts user
  ← because: user authenticated (custodial) or proved key possession (self-sovereign)
Therefore: requesting service trusts user (transitively)
```

### What makes a relay trusted?

A requesting service should only accept federated auth attestations from relays that are:

1. **Peered** — the relay's identity chain is on the requesting service's relay
2. **Conformant** — the relay has passed the Imajin conformance suite (RFC-21)
3. **Not revoked** — no revocation attestation exists for the relay

This is configurable per node. A strict node might require conformance certification. A permissive node might accept any peered relay. The requesting service decides its own trust policy.

## Attestation Format

The federated auth attestation is a standard DFOS JWS:

```json
{
  "alg": "EdDSA",
  "typ": "did:dfos:federated-auth",
  "kid": "did:dfos:home-relay-did#key_abc123",
  "cid": "bafyrei..."
}
.
{
  "type": "federated-auth",
  "version": 1,
  "subject": "did:dfos:user-did",
  "audience": "did:dfos:requesting-relay-did",
  "challenge": "a1b2c3d4...",
  "authenticatedAt": "2026-03-30T14:00:00Z",
  "homeRelay": "did:dfos:home-relay-did",
  "homeRelayUrl": "https://relay.example.com",
  "authMethod": "password",
  "expiresAt": "2026-03-30T14:05:00Z"
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| type | Yes | Always `federated-auth` |
| version | Yes | Protocol version (1) |
| subject | Yes | The user's DID |
| audience | Yes | The requesting service's relay DID — prevents replay to other services |
| challenge | Yes | Nonce from the auth request — proves freshness |
| authenticatedAt | Yes | When the user authenticated |
| homeRelay | Yes | The relay DID that signed this attestation |
| homeRelayUrl | Yes | URL of the home relay (for discovery) |
| authMethod | No | How the user authenticated (password, hardware-key, biometric) — informational |
| expiresAt | Yes | Attestation expiry — should be short (5 minutes) |

## Home Relay Discovery

The user enters their email. The requesting service needs to find which relay/node owns that email and the associated DID.

### Resolution Strategy (in order)

1. **Query peered Imajin nodes** — `GET /auth/resolve?email=user@example.com` on each known node. First match wins. Fast for the common case (user is on a node we peer with).

2. **Query DFOS platform** — if no Imajin node claims the email, ask the DFOS platform API. Requires Brandon to expose email → DID resolution (or a proxy endpoint). Covers DFOS-only users.

3. **Beacon-based discovery** — if we already know the DID (e.g., from a previous session or NFC card), the identity chain may include a beacon with the home relay URL. No email lookup needed.

4. **User provides relay URL** — fallback. User enters their relay URL manually. Like entering an email server — only for power users or when automated discovery fails.

**Privacy consideration:** Email resolution endpoints must be rate-limited, require the requesting service to authenticate (mutual TLS or signed request), and should not expose whether an email exists on the network to unauthenticated callers.

## Security Considerations

### Replay attacks
- **Challenge nonce** prevents replay of old attestations
- **Audience field** prevents using an attestation meant for service A on service B
- **Short expiry** (5 min) limits the window

### Relay impersonation
- Attestation signature is verified against the relay's identity chain
- Relay identity chain is obtained via peering (not from the attestation itself)
- A fake relay can't produce a valid signature for a real relay's DID

### Phishing (fake home relay page)
- Same risk as OAuth phishing (fake Google login page)
- Mitigation: user verifies they're on their actual home relay URL
- Future: hardware key / WebAuthn makes phishing ineffective

### Man-in-the-middle on callback
- Callback URL should be HTTPS
- Challenge is bound to the requesting service's session — intercepting the callback without the session is useless

### Home relay compromise
- If a home relay is compromised, it can forge attestations for its users
- This is equivalent to "Google gets hacked" in OAuth
- Mitigation: users can rotate keys and move to a different relay
- Detection: anomalous attestation patterns visible in the trust graph

## Relationship to Existing Auth

This does NOT replace Imajin's existing auth. It adds a federated path:

| Auth method | Key location | Use case |
|-------------|-------------|----------|
| Key import | User's own file | Power users, first registration |
| Password (stored key) | Encrypted in browser | Returning users, same device |
| **Federated — self-sovereign** | **User signs on home relay** | **Cross-node, user holds key** |
| **Federated — custodial** | **Home relay signs via KMS** | **Cross-node, DFOS platform users** |
| NFC card | On card | Physical onboarding (Muskoka card) |

## Implementation Phases

### Phase 1: Core flow
- `/auth/dfos/callback` endpoint on requesting service
- `/auth/federated` endpoint on home relay (Imajin's relay)
- Attestation creation and verification
- Auto-create local identity on first federated login

### Phase 2: Discovery
- Beacon-based home relay discovery
- DID input with relay URL fallback

### Phase 3: Trust policies
- Configurable trust levels per node
- Conformance certification requirement (optional)
- Relay reputation from trust graph

### Phase 4: Mutual auth
- Both parties authenticate — the requesting service proves its identity to the home relay too
- Prevents rogue services from harvesting auth attestations

## Open Questions

1. **DFOS email resolution:** Does the DFOS platform expose email → DID lookup? This is in the closed-source layer (AWS). Need Brandon to confirm whether an API exists or can be added. Without this, tier 3 auth for DFOS users is a non-starter.

2. **Email privacy on resolve:** How do we prevent email enumeration attacks on the `/auth/resolve` endpoint? Rate limiting + mutual auth between nodes? Or return the same response regardless of whether the email exists?

3. **Attestation storage:** Should federated auth attestations be stored on chain? They're ephemeral (5 min expiry) but could be useful for audit trails. Probably not — they'd bloat chains with noise.

4. **Session duration:** Once a federated user has a local session, how long does it last? Same as local users? Or shorter with periodic re-attestation?

5. **Scope/permissions:** Should the auth request include requested scopes (like OAuth scopes)? E.g., "I want to buy tickets" vs "I want admin access." The home relay could display these to the user.

6. **Node verification registry:** How does a requesting service determine if a home node is "verified" (tier 1 eligible)? Conformance certification on chain? A registry of approved builds? Manual allowlist?

7. **Offline/local-first:** When Brandon's single binary lands, the "home relay" might be the user's local device. The flow still works — redirect to localhost — but the UX is different.

8. **NFC card integration:** A card tap could initiate the federated flow automatically — card knows the user's DID and home relay, requesting service reads it and starts the redirect. Skips email entry entirely.

## References

- RFC-21: Imajin Conformance Suite (relay trust)
- RFC-19: Kernel/Userspace Architecture (app auth)
- DFOS 0.6.0: Identity chains, beacons, peering
- OAuth 2.0 / OpenID Connect (flow inspiration)
- SIWE — Sign-In with Ethereum (trust model inspiration)

---

*"Authenticate where you're sovereign. Prove it where you're visiting."*
