# RFC-29: Biometric Trust Escalation — Verifiable Credentials for Identity Binding

**Author:** Ryan Veteze
**Date:** April 23, 2026
**Status:** Draft
**Related:** RFC-13 (Progressive Trust), RFC-22 (Federated Authentication), RFC-27 (MCC), RFC-06 (Identity Portability)
**Standards:** KERI (Key Event Receipt Infrastructure), ACDC (Authentic Chained Data Containers), CESR, Trust over IP, W3C Verifiable Credentials

---

## Summary

A protocol for binding biometric verification to Imajin DIDs using third-party verifiable credentials. The biometric capture, matching, and credential issuance happen entirely outside Imajin — performed by registered verifier apps hosted on the infrastructure. Imajin never touches biometric data. What it receives is a cryptographically signed credential proving the holder passed biometric verification, bound to their DID.

This replaces passwords with presence. You don't remember a secret — you prove you're you.

## Problem

Imajin's identity model is keypair-based: you are your Ed25519 key. This is sovereign and portable, but it doesn't answer a critical question: **who holds the key?**

Today, the answer is "whoever has the device." That's fine for casual interactions (soft → preliminary trust), but insufficient for:

- **Financial transactions** above a threshold
- **Agent delegation** with real-world consequences
- **Owner claims** on stub identities (RFC-28)
- **Cross-device recovery** without centralized account recovery flows
- **Regulatory compliance** (KYC, eIDAS, travel credentials)

The gap: Imajin can prove a key signed something, but can't prove a specific human was the one who signed it. Biometric verification closes that gap without compromising sovereignty.

## Design Principles

1. **Imajin never stores or processes biometric data.** Not fingerprints. Not face templates. Not iris scans. Nothing. Ever.
2. **Biometric method is agnostic.** Face, fingerprint, iris, retina — the protocol doesn't care. The credential declares what was used; the trust policy declares what's accepted.
3. **Verifiers are pluggable.** Indicio, Regula, World ID, government eID providers — anyone who implements the verifier spec can issue credentials that Imajin accepts.
4. **Credentials are held by the user.** Not by Imajin. Not by the verifier. On the user's device, presented when needed, revocable by the user.
5. **Time-bound and renewable.** Credentials expire. Re-verification is a policy decision, not a permanent state.
6. **The chain records the attestation, not the biometric.** The identity chain gets "biometrically verified by [issuer DID] at [timestamp], method: [type], expires: [date]". That's it.

## Architecture

### Roles

| Role | Who | Responsibility |
|------|-----|----------------|
| **Subject** | The human | Provides biometric, holds credential, presents proof |
| **Verifier App** | Third party (e.g., Indicio) | Captures biometric, validates documents, issues credential |
| **Imajin Node** | The network | Validates credential signature, records attestation, enforces trust policy |

### Credential Flow

```
┌─────────┐     ┌──────────────┐     ┌─────────────┐
│  Human  │────▶│ Verifier App │────▶│ Imajin Node │
│ (Subject)│     │ (e.g. Indicio)│     │             │
└─────────┘     └──────────────┘     └─────────────┘
     │                  │                     │
     │  1. Biometric    │                     │
     │     capture      │                     │
     │  2. Document     │                     │
     │     verification │                     │
     │                  │                     │
     │  3. VC issued ◀──┘                     │
     │     (signed by                         │
     │      verifier DID)                     │
     │                                        │
     │  4. Present VC ──────────────────────▶ │
     │     + live biometric                   │
     │     match (on-device)                  │
     │                                        │
     │  5. Attestation recorded ◀──────────── │
     │     on identity chain                  │
```

### Step-by-Step

**1. Trigger.** User reaches a trust boundary: preliminary → established escalation, high-value transaction, owner claim on a stub, agent delegation requiring human confirmation.

**2. Redirect to Verifier App.** Imajin redirects the user to a registered verifier app (hosted on the Imajin infrastructure as a userspace app, or externally). The redirect includes:
- Subject DID
- Requested verification level
- Callback URL
- Challenge nonce (prevents replay)
- Node DID + signature (proves the request is from a legitimate node)

**3. Biometric Capture.** The verifier app performs:
- **Document verification** — government-issued ID scanned and validated
- **Liveness detection** — anti-spoofing (not a photo, not a deepfake)
- **Biometric capture** — face, fingerprint, iris, or other modality
- **Biometric match** — captured biometric matches the document

**4. Credential Issuance.** The verifier issues a W3C Verifiable Credential:

```json
{
  "@context": ["https://www.w3.org/2018/credentials/v1"],
  "type": ["VerifiableCredential", "BiometricVerification"],
  "issuer": "did:imajin:<verifier-did>",
  "issuanceDate": "2026-04-23T16:00:00Z",
  "expirationDate": "2027-04-23T16:00:00Z",
  "credentialSubject": {
    "id": "did:imajin:<subject-did>",
    "verificationType": "biometric",
    "methods": ["face", "fingerprint"],
    "livenessCheck": true,
    "documentVerification": true,
    "documentType": "passport",
    "documentCountry": "CA",
    "assuranceLevel": "high"
  },
  "proof": {
    "type": "Ed25519Signature2020",
    "verificationMethod": "did:imajin:<verifier-did>#key-1",
    "proofValue": "<signature>"
  }
}
```

The credential goes to the user's device. The biometric template stays on-device or is discarded.

**5. Presentation to Imajin.** User returns to the Imajin node and presents:
- The verifiable credential
- A verifiable presentation (fresh signature proving they hold the credential right now)
- On-device biometric match confirmation (the device confirms the live biometric matches the credential's bound template)

**6. Attestation.** The Imajin node:
- Verifies the verifier's DID is in the trusted verifier registry
- Verifies the credential signature
- Verifies the presentation is fresh (nonce, timestamp)
- Records an attestation on the subject's identity chain:

```json
{
  "type": "biometric_verification",
  "issuer": "did:imajin:<verifier-did>",
  "method": ["face", "fingerprint"],
  "assuranceLevel": "high",
  "issuedAt": "2026-04-23T16:00:00Z",
  "expiresAt": "2027-04-23T16:00:00Z",
  "credentialHash": "<sha256 of VC>"
}
```

No biometric data on the chain. Just the fact that verification happened, by whom, using what method, and when it expires.

## Trust Tier Integration (RFC-13)

Biometric verification slots into the existing progressive trust model:

| Tier | Current Mechanism | + Biometric |
|------|-------------------|-------------|
| **Soft** | Email / magic link | No change |
| **Preliminary** | Keypair generated, profile created | No change |
| **Established** | Vouched by established DID + milestones | Biometric VC accepted as equivalent to (or stronger than) a vouch |
| **Verified** *(new)* | — | Biometric VC + document verification. Highest assurance. |

### New: Verified Tier

RFC-13 defines three tiers. This RFC proposes a fourth: **Verified**. This tier requires a biometric credential from a trusted verifier. It is not required for most interactions but unlocks:

- **Owner claims** on stub identities (RFC-28) — you must prove you're the person/entity behind the claim
- **High-value settlements** — node-configurable threshold above which biometric confirmation is required
- **Agent delegation with financial authority** (RFC-27) — "this agent can spend up to $X on my behalf" requires biometric binding
- **Cross-node portable trust** — a biometric credential is verifiable by any node, unlike a vouch which is socially local
- **Regulatory compliance** — KYC, AML, eIDAS Level of Assurance High

### Biometric as Accelerated Onboarding

A user who presents a biometric VC can skip the vouch requirement for established status. The logic: if a trusted verifier has confirmed your identity with government documents and liveness, the network has stronger assurance than a social vouch provides.

Governance-configurable: each node/community decides whether biometric VC substitutes for social vouching.

## Verifier App Specification

A verifier app is a userspace application (RFC-19) that implements the biometric verification flow. It registers with the Imajin node like any other app, via cryptographic handshake.

### Registration

```json
{
  "appDid": "did:imajin:<verifier-did>",
  "name": "Indicio Verify",
  "type": "verifier",
  "capabilities": {
    "biometricMethods": ["face", "fingerprint", "iris"],
    "documentTypes": ["passport", "drivers_license", "national_id"],
    "assuranceLevels": ["low", "medium", "high"],
    "livenessDetection": true,
    "standards": ["eIDAS_LoA_High", "NIST_SP_800-63-3_IAL2"]
  },
  "endpoints": {
    "verify": "/api/verify",
    "status": "/api/status",
    "revoke": "/api/revoke"
  }
}
```

### Requirements

A conformant verifier app MUST:

1. **Never transmit raw biometric data** to the Imajin node or any third party
2. **Issue W3C Verifiable Credentials** signed with its registered DID
3. **Support liveness detection** to prevent spoofing
4. **Discard biometric templates** after credential issuance (or store only on-device, encrypted, under user control)
5. **Support credential revocation** (verifier discovers fraud → revokes credential → Imajin node updates attestation)
6. **Publish a privacy policy** declaring what data is collected, processed, and retained
7. **Pass the Imajin Verifier Conformance Suite** (to be defined)

### Conformance Suite

Like the DFOS relay conformance (106/106) and the Imajin application conformance suite (RFC-20), verifier apps must pass a conformance suite that tests:

- Credential format compliance
- Signature verification
- Revocation flow
- Privacy contract enforcement
- Liveness detection effectiveness
- Challenge-response freshness

## Biometric Login Flow

Once a user has a biometric VC, login becomes:

```
1. User opens Imajin on any device
2. Imajin presents challenge nonce
3. User's device performs local biometric match
   (fingerprint sensor, face camera, iris scanner)
4. Match confirmed → device signs challenge with
   user's Ed25519 key + presents VC
5. Node verifies: VC valid + signature valid +
   VC not expired + VC not revoked
6. Session created at verified trust level
```

No password. No OAuth redirect. No SMS code. You touch your phone, it proves you're you, and your key signs the challenge. The biometric never leaves the device.

### Cross-Device Recovery

Lost your phone? New device flow:

```
1. Re-verify with any trusted verifier app
   (same biometric, new credential bound to new keypair)
2. Verifier confirms biometric matches original verification
3. New credential issued, bound to new DID/keypair
4. User presents new credential + recovery claim to home node
5. Node verifies biometric continuity via verifier attestation
6. Identity chain records key rotation with biometric proof
```

No seed phrases. No recovery emails. Your face/fingerprint IS the recovery mechanism. The verifier attests "this is the same person who verified before" — the chain records the key rotation with that attestation as proof.

## Privacy Model

### What Imajin Stores
- Attestation type, issuer, method, assurance level, timestamps, credential hash
- **Nothing biometric. Ever.**

### What the Verifier Stores
- Defined by verifier's privacy policy (auditable)
- Conformance suite requires: biometric templates discarded or on-device only
- Document data: verifier may retain for compliance (KYC regulations), declared in privacy policy

### What the User Holds
- The verifiable credential (on-device)
- The biometric template (on-device, if retained for local matching)
- Full control: user can delete credential, refuse to present, revoke consent

### What Travels Over the Wire
- Verifiable Presentation (credential + fresh proof of possession)
- **Never:** raw biometric data, document images, PII

### Auditability
- Every verification event is attested on the identity chain
- Verifier's DID is public — their issuance history is auditable
- A verifier caught issuing fraudulent credentials has their DID revoked from the trusted registry — all credentials they issued become suspect

## Agent Implications (RFC-27)

Biometric verification creates a clean separation between human and agent identity:

- **Human DID:** biometrically verifiable. Can prove a real person is behind it.
- **Agent DID:** delegated by a biometrically verified human. The delegation chain is auditable: agent → parent DID → biometric attestation → verified human.

This matters for:
- **Financial regulation:** "who authorized this agent to transact?"
- **Liability:** the biometric chain answers "a verified human delegated this authority"
- **Agent revocation:** revoke the human's biometric credential → all agent delegations under that DID become suspect

## Node Policy Configuration

Each node configures its own biometric trust policy:

```json
{
  "biometricPolicy": {
    "trustedVerifiers": [
      "did:imajin:<indicio-did>",
      "did:imajin:<government-eid-provider>"
    ],
    "requiredFor": {
      "established": false,
      "verified": true,
      "ownerClaim": true,
      "settlementAbove": 1000,
      "agentDelegation": true
    },
    "acceptedMethods": ["face", "fingerprint", "iris"],
    "credentialMaxAge": "365d",
    "reVerificationTriggers": [
      "key_rotation",
      "settlement_above_threshold",
      "owner_claim"
    ]
  }
}
```

Federated nodes can set their own policies. A node in a high-regulation jurisdiction might require biometric for all transactions. A community node might never require it. The protocol supports both.

## Standards Alignment

| Standard | Relevance |
|----------|-----------|
| **KERI / ACDC / CESR** | **Reference standard.** Key Event Receipt Infrastructure for identifier verification; Authentic Chained Data Containers for credential chaining; Concise Event Streaming Representation for encoding. Trust over IP (Linux Foundation) ratified specs. |
| **W3C Verifiable Credentials** | Supported credential format alongside ACDC |
| **W3C DID Core** | Identifier model (already Imajin's foundation). `did:keri` accepted as external DID method. |
| **vLEI (GLEIF)** | Verifiable Legal Entity Identifiers — live production use of KERI for business identity. Natural integration for business scope verification. |
| **eIDAS 2.0 / EUDIW** | EU digital identity wallet — biometric VCs are the compliance path |
| **NIST SP 800-63-3** | Identity Assurance Levels (IAL2/IAL3 map to verified tier) |
| **ICAO DTC** | Digital Travel Credentials — travel vertical alignment (Tripian) |
| **ISO/IEC 30107** | Presentation attack detection (liveness) |
| **CSA Agent IAM** | Canadian Standards Association recommends DIDs for agent identity management |

## Reference Implementation: KERI/ACDC

The reference implementation for credential verification uses the KERI protocol suite (KERI, ACDC, CESR) rather than a specific vendor. This means:

1. **Imajin is a credential verifier, not an issuer.** The node verifies incoming KERI/ACDC credentials and maps them to attestations on Imajin DID chains. Credential issuance is the verifier's responsibility.

2. **`signify-ts`** (TypeScript KERI client, maintained by Web of Trust / Veridian team) provides the verification library. It handles CESR decoding, key state resolution, and ACDC signature verification.

3. **`did:keri` resolution.** The node resolves KERI Autonomic Identifiers (AIDs) to retrieve current key state for signature verification. No KERI infrastructure (witnesses, watchers) needs to run on the Imajin node — that's the issuer's infrastructure.

4. **ACDC → Attestation mapping.** Each ACDC credential type maps to an Imajin attestation type:

| ACDC Schema | Imajin Attestation | Trust Tier |
|-------------|-------------------|------------|
| Biometric verification | `biometric_verification` | Verified |
| vLEI (Legal Entity) | `legal_entity_verification` | Verified (business scope) |
| OOR (Official Organizational Role) | `role_attestation` | Established+ |
| Document verification | `document_verification` | Established |

5. **Multi-format support.** The verifier endpoint accepts both ACDC credentials (KERI-signed) and W3C Verifiable Credentials (JSON-LD signed). The attestation recorded on the Imajin chain is format-agnostic — it records what was verified, by whom, using what standard.

6. **Vendor verifiers plug in.** Indicio, Regula, government eID providers — any verifier that issues ACDC or W3C VC credentials can register as a trusted issuer. The node doesn't care who issued the credential, only that the cryptographic chain verifies and the issuer is in the trusted registry.

### What Imajin Builds

- KERI credential verification layer (`signify-ts` integration)
- `did:keri` resolution for external AID lookup
- ACDC schema → attestation type mapping
- Trusted issuer registry (KERI AIDs + W3C VC issuer DIDs)
- Credential presentation endpoint (accepts ACDC + W3C VC)
- Conformance tests against KERI test vectors

### What Imajin Does NOT Build

- KERI infrastructure (witnesses, watchers, key event logs) — issuer's responsibility
- Credential issuance — verifiers issue, Imajin verifies
- Wallet — users bring their own (Veridian, or any KERI-compatible wallet)
- Biometric capture — verifier's responsibility, never touches Imajin

## Implementation Phases

### Phase 1: KERI Verification Layer
- Integrate `signify-ts` into kernel
- Implement `did:keri` AID resolution
- ACDC credential signature verification
- Credential presentation endpoint (ACDC + W3C VC)
- Map ACDC schemas to Imajin attestation types

### Phase 2: Trusted Issuer Registry
- Node-level registry of accepted issuer AIDs/DIDs
- Admin console UI for managing trusted issuers
- Revocation mechanism for compromised issuers
- Seed with GLEIF root AID for vLEI credentials

### Phase 3: Attestation Integration
- Wire credential verification to identity chain attestations
- Trust tier escalation on successful verification
- Conformance tests against KERI test vectors

### Phase 4: Biometric Login
- On-device biometric match → challenge-response → session
- Replace password-based login with biometric-first flow
- Cross-device recovery via re-verification

### Phase 5: Vendor Verifier Onboarding
- Indicio, Regula, government eID providers as registered issuers
- Verifier app spec for hosting on Imajin infrastructure
- Cross-node portable trust via federated issuer registries

## Open Questions

1. **Credential portability between DID methods.** Resolved: accept both ACDC (KERI-signed) and W3C VC (JSON-LD signed). Verify the issuer signature regardless of method. `did:keri` and `did:imajin` coexist as recognized DID methods.

2. **Biometric template binding.** The VC says "face verified" — but how does the node confirm the local biometric match actually happened? Trusted device attestation? Platform API (Android BiometricPrompt, iOS LocalAuthentication)? This needs speccing.

3. **Revocation propagation.** When a verifier revokes a credential, how quickly must nodes invalidate the attestation? Real-time via webhook? Periodic check? Status list (W3C Bitstring Status List)?

4. **Multi-verifier credentials.** Can a user stack credentials from multiple verifiers for higher assurance? "Face verified by Indicio AND iris verified by World ID" = highest tier?

5. **Cost model.** Who pays for biometric verification? The user? The node? Subsidized for onboarding, charged for re-verification? Should the cost be denominated in MJNx?

6. **Liveness freshness.** For high-value transactions, should the node require a *fresh* biometric match (not just a valid credential)? What's the acceptable window — 30 seconds? 5 minutes?

---

*Biometric verification is the bridge between sovereign identity and real-world trust. You own your keys. A verifier proves you're the one holding them. The chain records the proof without ever seeing your face.*
