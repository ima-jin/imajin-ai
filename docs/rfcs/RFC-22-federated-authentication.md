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

### Two Authentication Tiers

| Tier | User type | Has keys? | Flow |
|------|-----------|-----------|------|
| **1. Direct key auth** | Imajin user (holds keypair) | Yes | Sign challenge on requesting service |
| **2. Email verification** | Any user (custodial or cross-platform) | No | Email code + chain lookup |

**Tier 1** is the strong path — user signs a challenge directly with their private key. This is existing Imajin login. Used when the user has their key available (stored key, key file, hardware key).

**Tier 2** is the universal path — works for everyone, regardless of key custody. No redirects. No OAuth dance. The user enters their email, we verify they own it, and we look up their identity chain for access level.

### Primary Flow: Email Verification (Tier 2)

This is the default for federated auth. No redirect to home relay needed.

```
1. User visits requesting service, clicks "Login from another network"

2. User enters their EMAIL ADDRESS
   — Not a DID. Nobody types did:dfos:7v4vtfnh7v28ka7af3cv79 into a login box.

3. Requesting service resolves email → DID + public key:
   → Query known peered relays/nodes: GET /auth/resolve?email=user@example.com
   → A relay claims it, returns: { did, publicKey, homeRelay }
   → If no relay claims it: "No account found for this email"

4. Requesting service sends email verification code to that address
   — Standard 6-digit code, 5 minute expiry
   — Same mechanism as existing MFA email codes

5. User enters the code
   → Proves they control the email bound to this DID
   → This IS the authentication — if you own the email, you are the identity

6. Requesting service looks up the DID's chain on its relay (via peering)
   → Check standing: attestation history, age, diversity
   → Determine trust level and access permissions

7. Session created
   — Auto-creates local identity if first visit (from chain state)
   — Trust level reflects chain standing, not just email ownership
```

The home relay's only job is answering: "what's the DID and public key for this email?" After that, the requesting service handles everything. The user never leaves the site.

### Direct Key Auth (Tier 1)

For Imajin users who hold their own keys — the stronger path:

```
1. User chooses "Login with key" (password-stored key, key file, etc.)
2. Requesting service issues challenge
3. User signs challenge with private key (client-side)
4. Verify signature against chain's public key
5. Session created with higher trust level
```

This is the existing Imajin login flow. Between verified Imajin nodes, this is preferred over email verification because it provides cryptographic proof of key possession, not just email ownership.

### Fallback: Home Relay Redirect

If the home relay won't expose email → DID resolution, or if the user needs to authenticate through a method only available on their home node (biometric, hardware key, etc.), the full redirect flow is available:

```
1. Redirect to home relay/node auth endpoint
2. User authenticates there (key never leaves their context)
3. Home relay signs attestation
4. Redirect back with signed attestation
5. Verify attestation against relay's chain key
6. Session created
```

This is the OAuth-style flow — more complex but covers edge cases where email verification isn't sufficient or available.

### Email Resolution

The email → DID lookup requires relays/nodes to expose a resolution endpoint:

```
GET /auth/resolve?email=user@example.com
→ { did: "did:dfos:abc123", publicKey: "z6Mkm...", homeRelay: "https://relay.example.com" }
```

- **Imajin nodes:** Profile data includes email. Resolution is straightforward.
- **DFOS platform:** Email → DID mapping is in the closed-source platform layer. Requires an API to be exposed (or proxy through the relay).
- **Privacy:** The resolve endpoint must be rate-limited and should require the requesting service to identify itself (signed request or mutual TLS). Must not reveal whether an email exists to unauthenticated callers.

### Sequence Diagram (Email Verification — Primary Flow)

```
User              Home Relay           Requesting Service
 │                   │                        │
 │  1. Enter email                            │
 │───────────────────────────────────────────>│
 │                   │  2. Resolve email→DID   │
 │                   │<──────────────────────│
 │                   │  3. Return DID + key    │
 │                   │──────────────────────>│
 │                   │                        │
 │  4. Email code sent                        │
 │<──────────────────────────────────────────│
 │  5. Enter code                             │
 │───────────────────────────────────────────>│
 │                   │  6. Lookup chain/standing│
 │                   │                        │
 │  7. Session created                        │
 │<──────────────────────────────────────────│
 │                   │                        │
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
| **Federated — direct key** | **User signs on requesting service** | **Cross-node, user holds key** |
| **Federated — email verify** | **No key needed** | **Cross-platform, custodial users, universal fallback** |
| **Federated — redirect** | **User signs on home relay** | **Fallback when email resolution unavailable** |
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

1. **DFOS email resolution:** Does the DFOS platform expose email → DID + public key lookup? This is in the closed-source layer. Need Brandon to confirm whether an API exists or can be added. Without this, email verification for DFOS users falls back to the redirect flow.

2. **Email privacy on resolve:** How do we prevent email enumeration attacks on the `/auth/resolve` endpoint? Options: rate limiting + mutual auth between nodes, return identical response shape regardless of existence, or require a signed request from a conformant node.

3. **Trust level difference:** Email verification proves email ownership. Direct key auth proves key possession. Should these result in different session trust levels? E.g., email-verified federated user gets read access but needs key auth for transactions?

4. **Session duration:** Once a federated user has a local session, how long does it last? Same as local users? Or shorter with periodic re-verification?

5. **Scope/permissions:** Should the requesting service declare what it needs? E.g., "browsing" vs "purchasing." Higher-trust operations could require tier 1 (direct key auth) even if the user initially authenticated via email.

6. **Offline/local-first:** When Brandon's single binary lands, the "home relay" might be the user's local device. Email verification still works. Direct key auth works better — local SQLite has the key.

7. **NFC card integration:** A card tap could skip email entry — card knows the user's DID and home relay. Requesting service reads it and resolves directly. Could also carry a pre-signed short-lived token for instant auth.

## References

- RFC-21: Imajin Conformance Suite (relay trust)
- RFC-19: Kernel/Userspace Architecture (app auth)
- DFOS 0.6.0: Identity chains, beacons, peering
- OAuth 2.0 / OpenID Connect (flow inspiration)
- SIWE — Sign-In with Ethereum (trust model inspiration)

---

*"Authenticate where you're sovereign. Prove it where you're visiting."*
