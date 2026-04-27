---
title: Federated Authentication
type: rfc
status: draft
author: Ryan Veteze
slug: RFC-22-federated-authentication
topics:
  - legibility
  - identity
  - agents
  - dfos
  - settlement
  - governance
  - events
  - federation
  - sovereignty
refs:
  rfcs:
  - 21
  - 19
---
# RFC-22: Federated Authentication

**Status:** Draft
**Author:** Ryan Veteze
**Date:** 2026-03-30

---

## Summary

A protocol for authenticating users across federated Imajin/DFOS nodes without exposing private keys to foreign services. Three tiers handle different trust levels and key custody models. The primary cross-platform flow uses a consent-and-sign redirect — the user authenticates on their home platform, consents to share identity data, and returns with a signed JWS artifact.

## Problem

With peered relays (ATX, NYC, LIS, Imajin), a user registered on one platform should be able to authenticate on another. The naive approach — "enter your DID and sign a challenge" — requires the user to input their private key into a foreign service's UI. This fundamentally breaks the sovereignty model.

Users will not (and should not) paste private keys into sites they don't control. Custodial users (DFOS platform) don't even have access to their keys. We need flows that respect key custody boundaries.

## Three Authentication Tiers

| Tier | User type | Has keys? | Flow | Trust level |
|------|-----------|-----------|------|-------------|
| **1. Direct key auth** | Imajin user on verified node | Yes | Sign challenge on requesting service | Highest — cryptographic proof |
| **2. Consent-and-sign redirect** | Any cross-platform user | Varies | Redirect to home platform consent screen | High — home platform vouches |
| **3. Email verification** | Fallback when redirect unavailable | No | Email code + chain lookup | Moderate — email ownership only |

---

## Tier 1: Direct Key Auth

For Imajin users who hold their own keys — the strongest path. No redirects, no third parties.

```
1. User chooses "Login with key" (password-stored key, key file, etc.)
2. Requesting service issues challenge
3. User signs challenge with private key (client-side, key never leaves browser)
4. Requesting service verifies signature against chain's public key
5. Session created with highest trust level
```

This is existing Imajin login. Used between verified Imajin nodes running the conformance suite with an approved build. The requesting service trusts the node's software to handle the key safely.

**When to use:** Imajin-to-Imajin. User is on a conformant node and holds their own key.

---

## Tier 2: Consent-and-Sign Redirect (Primary Cross-Platform Flow)

The primary flow for cross-platform authentication. Designed with Brandon (DFOS) and Vinny. Solves the custodial key problem: how does a user whose keys are managed by their platform "sign" a challenge for a third party?

**Answer:** A consent screen on the home platform. The user authenticates there, consents to sharing their identity with the requesting service, and the home platform signs a challenge on their behalf. The signed JWS artifact is returned via redirect.

### Flow

```
1. User visits requesting service (e.g., events.imajin.ai)
   → Clicks "Login with DFOS" (or "Login from another node")

2. Requesting service generates a challenge nonce and redirects:
   GET https://home-platform.example.com/auth/consent
     ?challenge=<random-nonce>
     &callback=https://events.imajin.ai/auth/callback
     &requesting_did=<requesting-service-relay-DID>
     &scopes=identity,email    ← what data the requesting service wants

3. Home platform authenticates the user locally
   — Email code, password, biometric, KMS-backed — whatever the platform supports
   — Private key NEVER leaves this context

4. Home platform shows consent screen:
   "Imajin Events wants to verify your identity and access your email.
    [Allow]  [Deny]"
   — User sees exactly what's being shared
   — Scopes are explicit (identity, email, profile, etc.)

5. User consents → home platform signs the challenge + consented data:
   — For custodial users: platform signs via KMS using user's managed key
   — For self-sovereign users: user signs directly, platform countersigns
   — Result: a JWS artifact containing the challenge, user's DID, consented data

6. Home platform redirects back:
   GET https://events.imajin.ai/auth/callback
     ?artifact=<signed-JWS-token>

7. Requesting service verifies:
   a. Decode JWS, extract signer DID
   b. Look up signer's identity chain on own relay (via peering)
   c. Verify signature against chain's public key
   d. Verify challenge matches what was issued in step 2
   e. Verify audience matches own DID (prevents replay to other services)
   f. Verify expiresAt has not passed
   g. Extract consented data (email, profile info, etc.)

8. Session created
   — Auto-creates local identity if first visit (from chain state)
   — Trust level and access based on chain standing + consented scopes
```

### Why Consent Screen > Email Resolution

Brandon confirmed: email → DID mapping is private, platform-layer only. No programmatic lookup by design. The consent screen solves this elegantly:

- **Email stays private** until the user explicitly consents to share it
- **User controls what's shared** — scopes are visible on the consent screen
- **No email enumeration risk** — there's no resolve endpoint to attack
- **Works for custodial AND self-sovereign users** — the consent screen is the universal gate
- **Home platform handles all auth complexity** — KMS, email codes, biometrics, whatever. The requesting service just gets back a signed artifact.

### Sequence Diagram

```
User            Home Platform         Requesting Service
 │                   │                        │
 │  1. "Login with DFOS"                      │
 │───────────────────────────────────────────>│
 │                   │    2. Redirect + challenge
 │<──────────────────────────────────────────│
 │  3. Authenticate  │                        │
 │──────────────────>│                        │
 │  4. Consent screen│                        │
 │<─────────────────│                        │
 │  5. "Allow"       │                        │
 │──────────────────>│                        │
 │                   │  6. Sign artifact       │
 │  7. Redirect back with JWS                 │
 │<─────────────────│                        │
 │───────────────────────────────────────────>│
 │                   │    8. Verify + session  │
 │<──────────────────────────────────────────│
```

### Artifact Format

The consent artifact is a standard DFOS JWS:

```json
{
  "alg": "EdDSA",
  "typ": "did:dfos:federated-auth",
  "kid": "did:dfos:user-did#key_abc123",
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
  "authMethod": "custodial|password|hardware-key|biometric",
  "consented": {
    "email": "user@example.com",
    "displayName": "Carmen S.",
    "profile": true
  },
  "expiresAt": "2026-03-30T14:05:00Z"
}
```

The `consented` field contains only what the user approved on the consent screen. If they denied email access, the field is absent. The requesting service works with whatever it gets.

### Key Custody — How Each Platform Signs

| Platform | Key custody | Who signs the artifact |
|----------|-----------|----------------------|
| **DFOS platform** | AWS KMS (custodial) | Platform signs via KMS using user's managed key |
| **Imajin (stored key)** | Browser, password-encrypted | User signs client-side, node countersigns |
| **Imajin (key import)** | User's own file | User signs directly |
| **Future (Go binary)** | Local SQLite on device | User signs on own hardware |

The requesting service doesn't care which method was used. It verifies the JWS signature against the chain's public key. Whether that key was accessed via KMS, decrypted from browser storage, or loaded from hardware is the home platform's business.

The optional `authMethod` field indicates how the user authenticated. A requesting service MAY require a specific method for high-value operations (e.g., "custodial auth is fine for browsing, but purchasing requires direct key proof").

---

## Tier 3: Email Verification (Fallback)

When the home platform doesn't support the consent redirect (no UI built yet, platform is offline, etc.), email verification is the fallback:

```
1. User enters their email address
2. Requesting service sends verification code to that email
3. User enters code → proves email ownership
4. Requesting service searches peered relays for an identity chain associated with that email
5. If found: session created with moderate trust level
6. If not found: offer to create a new identity
```

This is weaker than tier 2 — it proves email ownership but not DID control. The requesting service can't verify a chain signature because it doesn't have a signed artifact. Trust level is lower.

**When to use:** Fallback only. When the home platform can't do the consent redirect.

---

## Home Platform Discovery

How does the requesting service know where to redirect?

### For "Login with DFOS"
The redirect URL is well-known: DFOS platform's consent endpoint. Configured once per integration.

### For "Login from another Imajin node"
Options, in order:
1. **User selects their node** from a list of peered nodes (like choosing a Mastodon instance)
2. **Beacon-based** — if we know the DID (previous session, NFC card), the chain's beacon includes the home node URL
3. **User enters node URL** — power user fallback

### For NFC card
The card knows the user's DID and home platform. Tap initiates the redirect automatically — no manual selection needed.

---

## Trust Model

The requesting service trusts the **home platform**, which vouches for the user.

```
Requesting service trusts home platform
  ← peered, conformant (RFC-21), identity chain verified
Home platform trusts user
  ← authenticated (custodial, password, biometric, key)
Therefore: requesting service trusts user (transitively)
```

### What makes a platform trusted?

1. **Peered** — the platform's relay identity chain is on the requesting service's relay
2. **Conformant** — passed the Imajin conformance suite (RFC-21) — optional but increases trust
3. **Not revoked** — no revocation attestation exists

Configurable per node. A strict node requires conformance certification. A permissive node accepts any peered relay.

---

## Relationship to Existing Auth

This does NOT replace Imajin's existing auth. It adds federated paths:

| Auth method | Key location | Use case |
|-------------|-------------|----------|
| Key import | User's own file | Power users, first registration |
| Password (stored key) | Encrypted in browser | Returning users, same device |
| **Tier 1 — Direct key** | **User signs on requesting service** | **Cross-node, verified Imajin nodes** |
| **Tier 2 — Consent redirect** | **User signs on home platform** | **Cross-platform (DFOS ↔ Imajin), primary federated flow** |
| **Tier 3 — Email verify** | **No key needed** | **Fallback when redirect unavailable** |
| NFC card | On card | Physical onboarding (Muskoka card) |

---

## Security Considerations

### Replay attacks
- **Challenge nonce** prevents replay of old artifacts
- **Audience field** prevents using an artifact meant for service A on service B
- **Short expiry** (5 min) limits the window

### Relay impersonation
- Artifact signature verified against the identity chain obtained via peering (not from the artifact itself)
- A fake platform can't produce a valid signature for a real DID

### Phishing (fake consent screen)
- Same risk as OAuth phishing (fake Google login page)
- Mitigation: user verifies they're on their actual home platform URL
- Future: hardware key / WebAuthn makes phishing ineffective

### Man-in-the-middle on callback
- Callback URL must be HTTPS
- Challenge bound to requesting service's session

### Home platform compromise
- Compromised platform can forge artifacts for its users (same as "Google gets hacked" in OAuth)
- Mitigation: users can rotate keys and migrate to another platform
- Detection: anomalous patterns in the trust graph

### Consent scope creep
- Requesting service declares scopes up front
- Home platform shows exactly what's being shared
- User can deny individual scopes
- No silent data collection — everything is explicit on the consent screen

---

## Implementation Phases

### Phase 1: Imajin ↔ DFOS consent flow
- Implement consent screen on Imajin (`/auth/consent`)
- Implement callback handler on Imajin (`/auth/callback`)
- Coordinate with Brandon on DFOS platform consent endpoint
- Artifact creation and verification

### Phase 2: Imajin ↔ Imajin (multi-node)
- Node selection UI ("which Imajin node are you from?")
- Direct key auth between verified nodes (tier 1)
- Consent redirect between unverified nodes (tier 2)

### Phase 3: Discovery + NFC
- Beacon-based home platform discovery
- NFC card auto-redirect
- "Remember my home platform" for returning users

### Phase 4: Mutual auth + scopes
- Requesting service proves its identity to home platform (prevents rogue services)
- Granular scope negotiation
- Standing-gated access levels

---

## Open Questions

1. **Consent endpoint coordination:** Brandon/Vinny identified the consent-and-sign pattern. What's the timeline for DFOS platform to expose a consent endpoint? Is this something we build in parallel and test against each other's implementations?

2. **Scope vocabulary:** What scopes should be standardized? `identity` (DID only), `email`, `profile` (display name, avatar), `standing` (trust level). Platform-specific scopes beyond these?

3. **Artifact signer:** For custodial users, is the artifact signed by the user's managed key (via KMS) or by the platform's relay key? User's key is more verifiable (chain lookup works directly). Platform's key requires trusting the platform's assertion.

4. **Trust level differentiation:** Should tier 2 (consent redirect) result in different permissions than tier 1 (direct key)? E.g., consent auth is fine for browsing/purchasing, but admin operations require direct key proof?

5. **Session duration:** Federated sessions — same duration as local? Shorter with periodic re-auth?

6. **Offline/local-first:** When Brandon's Go binary ships (local SQLite), the consent screen runs on localhost. Flow still works but UX is different — redirect to `localhost:PORT`.

7. **NFC card + consent:** Card tap could pre-populate the redirect (card knows DID + home platform). One-tap federated auth.

8. **Mutual registration:** When a DFOS user authenticates on Imajin via consent, we create a local identity. Should Imajin reciprocally register awareness of that user on the DFOS side? Or is that unnecessary — the peered relay already has the chain.

## References

- RFC-21: Imajin Conformance Suite (relay trust, node verification)
- RFC-19: Kernel/Userspace Architecture (app auth, userspace compliance)
- DFOS 0.6.0: Identity chains, beacons, peering
- Brandon (Clearbyte): Consent-and-sign pattern, KMS key custody model
- Vinny: Original consent screen concept for custodial DID signing
- OAuth 2.0 / OpenID Connect (flow inspiration)
- SIWE — Sign-In with Ethereum (trust model inspiration)

---

*"Authenticate where you're sovereign. Prove it where you're visiting."*
