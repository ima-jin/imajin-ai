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

### Flow

```
1. User visits requesting service, clicks "Login with DFOS"

2. User provides their DID (did:dfos:abc123)
   — OR the requesting service discovers it (e.g., from a previous session, NFC card, QR)

3. Requesting service looks up the DID on its own relay
   → Finds the identity chain (via peering/gossip)
   → Extracts the home relay URL from the chain metadata (or beacon)
   → If not found: "Unknown identity — not on any peered relay"

4. Requesting service redirects user to home relay auth endpoint:
   GET https://home-relay.example.com/auth/federated
     ?did=did:dfos:abc123
     &callback=https://requesting-service.example.com/auth/dfos/callback
     &challenge=<random-nonce>
     &requesting_did=<requesting-service-relay-DID>
     &timestamp=<ISO-8601>

5. Home relay authenticates the user locally
   — Password, biometric, hardware key, stored key — whatever the home relay supports
   — Private key NEVER leaves this context

6. Home relay creates a signed attestation (FederatedAuthAttestation):
   {
     type: "federated-auth",
     subject: "did:dfos:abc123",          // the user
     audience: "<requesting-service-DID>", // who this attestation is for
     challenge: "<nonce-from-step-4>",     // proves freshness
     authenticatedAt: "<ISO-8601>",
     homeRelay: "did:dfos:home-relay-did",
     expiresAt: "<ISO-8601>",             // short-lived (5 min)
   }
   Signed as a JWS by the home relay's DID.

7. Home relay redirects back to requesting service:
   GET https://requesting-service.example.com/auth/dfos/callback
     ?attestation=<JWS-token>

8. Requesting service verifies the attestation:
   a. Decode JWS, extract home relay DID from header
   b. Look up home relay's identity chain on own relay (must be peered)
   c. Verify JWS signature against home relay's public key
   d. Verify challenge matches what was issued in step 4
   e. Verify audience matches own DID
   f. Verify timestamp is within acceptable window
   g. Verify expiresAt has not passed
   h. Verify home relay is trusted (peered + conformant)

9. Requesting service creates a local session for the user
   — Auto-creates local identity if first visit (from chain state)
   — Returns session token / sets cookie
```

### Sequence Diagram

```
User            Home Relay           Requesting Service
 │                 │                        │
 │  1. Click "Login with DFOS"              │
 │─────────────────────────────────────────>│
 │                 │    2. Redirect to home  │
 │<────────────────────────────────────────│
 │  3. Authenticate│locally                 │
 │────────────────>│                        │
 │                 │  4. Sign attestation    │
 │                 │                        │
 │  5. Redirect back with attestation       │
 │<───────────────│                        │
 │─────────────────────────────────────────>│
 │                 │    6. Verify + session  │
 │<────────────────────────────────────────│
 │                 │                        │
```

## Trust Model

The requesting service does NOT trust the user directly. It trusts the **home relay**, which vouches for the user.

Trust chain:
```
Requesting service trusts home relay
  ← because: peered, conformant (RFC-21), identity chain verified
Home relay trusts user
  ← because: user proved key possession locally
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

How does the requesting service know WHERE to redirect the user?

### Option A: User provides relay URL

Simple. User enters their DID and their home relay URL. Like entering an email — `user@relay.example.com`. The DID format could encode this: `did:dfos:abc123@relay.example.com`.

### Option B: Beacon-based discovery

The user's identity chain includes a beacon with their home relay URL. The requesting service resolves the DID on its own relay (via peering) and reads the beacon. No user input beyond the DID.

### Option C: Well-known relay registry

A DNS-like lookup: given a DID, query known relays until one claims it. Slow but requires nothing from the user.

**Recommended: Option B** with Option A as fallback. Beacons are already a DFOS primitive. If the beacon exists, zero user friction. If not, ask for the relay URL.

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
| Key import | User pastes key | Power users, first registration |
| Password (stored key) | Encrypted in browser | Returning users, same device |
| **Federated (this RFC)** | **User's home relay** | **Cross-node access, new services** |
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

1. **Attestation storage:** Should federated auth attestations be stored on chain? They're ephemeral (5 min expiry) but could be useful for audit trails. Probably not — they'd bloat chains with noise.

2. **Session duration:** Once a federated user has a local session, how long does it last? Same as local users? Or shorter with periodic re-attestation?

3. **Scope/permissions:** Should the auth request include requested scopes (like OAuth scopes)? E.g., "I want to buy tickets" vs "I want admin access." The home relay could display these to the user.

4. **Offline/local-first:** When Brandon's single binary lands, the "home relay" might be the user's local device. The flow still works — redirect to localhost — but the UX is different.

5. **NFC card integration:** A card tap could initiate the federated flow automatically — card knows the user's DID and home relay, requesting service reads it and starts the redirect.

## References

- RFC-21: Imajin Conformance Suite (relay trust)
- RFC-19: Kernel/Userspace Architecture (app auth)
- DFOS 0.6.0: Identity chains, beacons, peering
- OAuth 2.0 / OpenID Connect (flow inspiration)
- SIWE — Sign-In with Ethereum (trust model inspiration)

---

*"Authenticate where you're sovereign. Prove it where you're visiting."*
