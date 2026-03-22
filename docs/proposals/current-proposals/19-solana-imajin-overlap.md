## STATUS: CORE FINDING SPEC ADOPTED — PATHWAY DECISION PENDING
**Adopted:** 2026-03-17
**Evidence:** `docs/rfcs/RFC-11-embedded-wallet.md` in upstream main (HEAD 23b9f2a). RFC-11 explicitly records the March 9, 2026 realization event and confirms the Ed25519 convergence as architectural fact. The core thesis of this proposal — that every DID keypair IS a Solana wallet — is now canonical in the protocol spec.
**Outcome:** Ed25519 convergence confirmed and documented. MJN-scoped-only wallet design adopted (containing blast radius). Three-tier identity model (soft/preliminary/established) is live in code. Pathway 1 (member invitation → keypair → preliminary DID) is the active model for April 1 launch.
**What remains open:** Pathway 2 (Solana wallet + MJN purchase → preliminary DID) — blocked on legal review. 5 open questions for Ryan (MJN threshold, soft→preliminary upgrade, invite gate replacement, continuous holding requirement, regulatory timeline) still unanswered.
**Implementation:** Core finding in spec; three-tier model fully shipped in code; Pathway 2 in spec only pending legal.

---

## Update — 2026-03-20

### Stable DID Migration Landed (#371, HEAD 39f198d)

Soft DIDs have changed format. Previously `did:email:username_at_domain_com` — now `did:imajin:{nanoid(44)}`. Both `session/soft` and `onboard/verify` now mint the same format via `nanoid(44)`. Email is stored separately in `auth.credentials` (type=`email`, value=normalized email). Two new shared utilities: `getEmailForDid()` / `getDidForEmail()` in `packages/auth/src/credentials.ts`.

**Impact on this proposal:** The "Soft DIDs Are Not Affected" section below remains correct — soft DIDs still use a placeholder key (`soft_${nanoid(32)}`), not a real Ed25519 keypair, so they are still not Solana wallets. The format change does not affect the Ed25519 convergence claim. However, the `isValidDID()` function in `packages/auth/src/providers/keypair.ts` (line 228) now validates only 16-char hex suffixes — it will reject all soft DIDs (44-char nanoid). This is a latent bug if any code path calls `isValidDID()` on a soft DID identity; however, the codebase has largely replaced DID-string parsing with tier-based gating, so the blast radius is limited.

**The `createDID()` inconsistency is unchanged.** `packages/auth/src/providers/keypair.ts:createDID()` (line 49) still produces `did:imajin:{pubkey.slice(0,16)}` — 16-char hex truncation. This has not been resolved by #371. The inconsistency flagged in this proposal (shared package vs. server format) remains active.

### DFOS DID Bridge Filed (#395–400, 2026-03-21)

Discussion #393 (30K+ word DFOS × Imajin technical deep dive) turned into 6 filed issues overnight:

- **#395** — Epic: DFOS DID Bridge (chain-backed identity for `did:imajin`)
- **#396** — `@imajin/dfos` shared package — keypair bridging + chain creation
- **#397** — `identity_chains` table + DFOS credential migration
- **#398** — DFOS chain resolution endpoints + bidirectional lookup
- **#399** — Key format utilities — hex ↔ multikey ↔ bytes conversion
- **#400** — DAG-CBOR content addressing — CID-address all portable content

Both DFOS and Imajin use `@noble/ed25519` — keys are byte-compatible. The DFOS bridge means the same Ed25519 keypair now simultaneously controls:

1. An Imajin preliminary DID (`did:imajin:{base58(pubkey)}`)
2. A Solana wallet address (same base58 bytes)
3. A DFOS identity chain (same keypair → chain-derived self-certifying DID)

The convergence this proposal identified is now a three-way fact. DFOS adds key rotation and Merkle beacon capabilities that Imajin does not yet have — the bridge work in #395–400 is likely to inform future DID rotation design.

**Pathway 2 connection:** A user arriving via Solana wallet (Pathway 2) would automatically have all three: Imajin DID, Solana wallet, and DFOS chain derivable from the same keypair. This strengthens the case for Pathway 2 as the "power user" entry point once the bridge is live.

### Agent Sub-Identities Filed (#394, 2026-03-20)

Issue #394 (VC delegation, sidecar DIDs, human/agent protocol enforcement) directly affects the identity surface of this proposal. Agent DIDs operate alongside human DIDs — they are not Solana wallets by default (agent keypairs may be ephemeral or server-managed). This is a new tier of identity that the Pathway comparison table below does not yet account for.

---

# Proposal 19 — Solana / Imajin DID Overlap: Architecture and Registration Pathways

**Filed:** 2026-03-13
**Author:** Greg Mulholland (Tonalith)
**Relates to:** RFC #268 (Embedded Wallet), Proposal 01 (Progressive Trust Model), Proposal 04 (Embedded Wallet)
**Affects:** `apps/auth`, `packages/auth`, `apps/pay/lib/providers/solana.ts`
**Milestone:** April 1, 2026 launch — registration pathway must be decided before this date

---

## Three-Tier Model Update — 2026-03-13

Ryan's Identity & Attestation Hardening Roadmap (March 13) confirmed the binary `soft/hard` tier is being replaced with a three-tier model: **soft → preliminary → established**. This affects the language throughout this document:

- **"Hard DID"** → **"Preliminary DID"** — the first tier above soft, issued at keypair-based registration
- **"Established DID"** — a new tier above preliminary, unlocked by the vouch flow (not yet in code)
- Both pathways described below issue a `preliminary` DID, not a generic "hard DID"
- Phase 0 of the roadmap (issue #319) adds the `tier` column to `auth.identities` — this is the same migration P2 requested, now formally committed
- `requireHardDID()` in `packages/auth/src/require-hard-did.ts` may be renamed to `requirePreliminaryDID()` or `requireEstablishedDID()` when the three-tier model ships in code

The open questions and comparison table below have been updated to use the new tier terminology.

---

## The Cryptographic Fact

Imajin and Solana both use **Ed25519** as their keypair curve. This is not incidental — it means the same 32-byte private key generates a valid identity in both systems simultaneously. There is no bridge, no derivation step, no conversion. The keypair is the same object.

The production DID format (`apps/auth/lib/crypto.ts`) encodes this directly:

```typescript
export function didFromPublicKey(publicKeyHex: string): string {
  const publicKeyBytes = hexToBytes(publicKeyHex);
  const encoded = bs58.encode(publicKeyBytes);   // same base58 encoding Solana uses
  return `did:imajin:${encoded}`;
}
```

A production Imajin preliminary DID looks like:

```
did:imajin:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
           └─────────────────────────────────────────┘
           base58(32-byte Ed25519 public key)
           identical bytes to a Solana wallet address
```

The DID suffix and the Solana address are the same 32 bytes in the same base58 encoding. `publicKeyFromDid()` exists and reverses this exactly — the full public key is recoverable from the DID string by design.

**Consequence:** Every existing Imajin keypair-based DID (now called "preliminary DID" in the three-tier model) controls a Solana wallet address. The user who downloaded their `imajin-key-handle.json` backup file already holds a file that is, by its cryptographic content, a Solana wallet. This has not been communicated to users and no UI exposes it.

---

## What the Backup File Contains

On hard DID registration, the auth app presents a key backup screen and downloads:

```json
{
  "did": "did:imajin:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
  "handle": "ryan",
  "keypair": {
    "publicKey": "a1b2c3...  (64 hex chars = 32 bytes)",
    "privateKey": "d4e5f6...  (64 hex chars = 32 bytes)"
  },
  "exportedAt": "2026-03-13T...",
  "warning": "This file contains your private key..."
}
```

To use this keypair as a Solana wallet in Phantom or Solflare, the 32-byte private key and 32-byte public key are concatenated into a 64-byte `secretKey` and imported as a JSON byte array. This conversion is trivial but undocumented. No UI in Imajin currently performs or guides this step.

---

## Soft DIDs Are Not Affected

~~Email-onboarded identities (`did:email:username_at_domain_com`)~~ **Updated 2026-03-20:** Soft DIDs now use `did:imajin:{nanoid(44)}` format following stable DID migration #371. Email is decoupled from the DID string and stored in `auth.credentials`. The placeholder key remains `soft_${nanoid(32)}` — not a real Ed25519 keypair. Soft DID holders do not have Solana wallets. The duality described in this proposal applies exclusively to preliminary and established DIDs (keypair-based registrations).

---

## Security Model: Why Identity Theft via Public Key Is Not Possible

A Solana wallet address is a public key — it is public by definition, broadcast on-chain, visible to anyone. Knowing Alice's Solana address does not allow registering as Alice in Imajin, because the registration route (`apps/auth/app/api/register/route.ts`) requires the client to sign a payload with the corresponding private key:

```typescript
const isValid = await verifySignature(payloadToSign, signature, publicKey);
if (!isValid) { return 401; }
```

The server verifies the signature before creating the identity. Without the private key, the registration cannot be completed. The challenge-response is the security boundary, and it holds regardless of which registration pathway is used.

---

## Known Code Inconsistency

Two DID construction functions exist in the codebase and produce incompatible output from the same key:

| Location | Function | Output format | Used by |
|---|---|---|---|
| `apps/auth/lib/crypto.ts` | `didFromPublicKey()` | `did:imajin:{base58(full 32 bytes)}` | Register route — writes to DB |
| `packages/auth/src/providers/keypair.ts` | `createDID()` | `did:imajin:{first 16 hex chars}` | Shared package — client consumers |

The shared package function produces an 8-byte (64-bit) prefix of the key, not a full identifier. Any client library consumer calling `createDID()` generates DIDs that do not match what the server stores. This is an active inconsistency that should be resolved by updating `packages/auth/src/providers/keypair.ts` to match the server's `didFromPublicKey()` format before external consumers build on it.

---

## Two Registration Pathways to Preliminary DID

The current system has one path to a keypair-based DID: invite code + browser keypair generation. The following two pathways represent a fork in the identity onboarding philosophy. They are not mutually exclusive — both can coexist as entry points to the same preliminary DID tier.

---

### Pathway 1 — Member Invitation → Browser Keypair → Preliminary DID

**The existing flow, formalized and extended.**

A member of the network issues an invite. The invitee receives a link, generates an Ed25519 keypair in the browser, signs a registration payload, and receives a preliminary DID. The invite establishes the initial trust connection.

The soft DID → preliminary DID upgrade path (currently undefined in code) would follow the same ceremony: the user generates a keypair, signs a migration payload, and the `auth.identities` record is updated — the DID itself would change from `did:imajin:{nanoid(44)}` to `did:imajin:{base58(pubkey)}`, since the soft DID's nanoid suffix has no relationship to a keypair. This is a DID replacement, not an upgrade in place. All foreign key references across 14+ schemas must be updated atomically — the `migrate-stable-dids.ts` migration script (#371) demonstrates this pattern and could serve as a template. Phase 0 of the Identity Hardening Roadmap (#319) establishes the `tier` column in `auth.identities` that this upgrade path writes to.

**What this requires that doesn't exist yet:**
- A defined soft → hard DID upgrade flow (no code or spec exists)
- UI guidance that the downloaded backup file is also a Solana wallet

**Pros:**

- **No crypto prerequisite.** Users arrive with nothing but an email address and an invite. The keypair is generated for them in the browser using `crypto.getRandomValues()`. No wallet app, no token purchase, no exchange account.
- **Consistent with the existing model.** The invite gate is already in production. Extending it to formalize the soft → hard upgrade is incremental work.
- **Accessible globally.** No dependency on crypto on-ramps, exchange availability, or local regulations around digital asset purchases.
- **The trust signal is social.** A person vouched for by an existing member starts with a real connection in the trust graph. The relationship exists before the identity is issued.
- **Lower onboarding friction.** The path from "I received an invite" to "I have a hard DID" is a single browser session.

**Cons:**

- **Invite codes are a social gate, not an economic one.** They can be shared, distributed informally, or issued in bulk by early members. There is no cost to generating a fake identity if invite codes are obtainable.
- **Sybil resistance is weak.** A single insider with invite privileges can create many identities at zero cost. The trust graph only limits this if connections are genuinely meaningful — which is not enforceable at the protocol level.
- **Key management is unfamiliar.** Users generating a keypair in a browser and downloading a JSON file are not accustomed to the security implications. Loss of the file = permanent loss of identity, with no recovery path. This is explained in the UI but not internalized by most users until it's too late.
- **The Solana wallet is invisible.** Users who registered via this path own a Solana wallet they don't know about. The backup file is not labeled as such. When the embedded wallet is surfaced, it will be a surprise — which can be positive or disorienting depending on implementation.
- **No economic stake in the network.** The identity carries no financial commitment. There is no signal that this person intends to participate beyond the initial invite.

---

### Pathway 2 — Solana Wallet + MJN Token Purchase → Preliminary DID

**A proposed inversion: economic proof-of-personhood precedes identity issuance.**

The user creates a Solana wallet using any standard wallet application (Phantom, Solflare, Backpack). They purchase a minimum quantity of MJN tokens. They connect their wallet to the Imajin registration flow, which verifies the on-chain token balance, issues a challenge nonce, and receives a signature from the wallet. The DID is issued from the same keypair — `did:imajin:{base58(pubkey)}` — so the identity and the wallet are unified from the first moment. The issued DID starts at `preliminary` tier; reaching `established` tier requires the vouch flow (Phase 2, #321).

**What this requires that doesn't exist yet:**
- A "Connect Wallet" UI path in `apps/auth/app/register/`
- An on-chain MJN balance check in the register route using `connection.getTokenAccountsByOwner()` — the `Connection` and MJN token address (`12rXuUVzC71zoLrqVa3JYGRiXkKrezQLXB7gKkfq9AjK`) are already in `apps/pay/lib/providers/solana.ts`
- A minimum balance threshold defined as a USD-equivalent value (not a fixed token count, to account for price movement)
- MJN available to purchase via at least one accessible exchange or direct sale

**Pros:**

- **Sybil resistance is economic.** Creating a fake identity costs real money. The on-chain balance check is verifiable by the auth service without trusting the user's claim. Each hard DID represents a minimum financial commitment.
- **MJN demand is bootstrapped by identity registration.** Every hard DID issued = at least one MJN purchase. At the April 1 launch, if this pathway is active, the first transactions on the network are the identity registrations themselves — not an artificial demo transaction.
- **Key management is understood from day one.** Users arriving from Phantom understand that their private key controls real assets. They already have backup practices — seed phrase storage, hardware wallet support. The identity inherits those practices rather than requiring Imajin to educate users from scratch.
- **The wallet and identity are unified without a discovery step.** There is no moment where the user learns "by the way, your Imajin identity is also a Solana wallet." It starts as a Solana wallet and becomes an Imajin identity — the order removes the conceptual gap.
- **The on-chain balance is a continuous attestation.** After registration, the token holding is a public, verifiable fact. Unusual behavior (e.g., immediate sell-off of all tokens after registration) is visible on-chain and can inform trust scoring.
- **Invite gate is not required.** The economic gate replaces the social gate. A user with MJN tokens does not need to know anyone in the network to register.

**Cons:**

- **Crypto onboarding is a real barrier.** Purchasing MJN tokens requires: a compatible exchange or DEX, a fiat on-ramp, passing KYC on the exchange, understanding gas fees, and understanding wallet security. This is inaccessible to a significant portion of the intended user base.
- **MJN must have liquidity before this gate can be enforced.** If MJN is not available to purchase easily, requiring it blocks all registrations. The gate cannot precede the market.
- **Price volatility makes the access cost unpredictable.** A threshold defined in token count (e.g., "hold 1 MJN") fluctuates in real-cost terms. The minimum should be defined as a USD-equivalent (e.g., "$1 of MJN at registration time") with an on-chain price oracle check — which adds implementation complexity.
- **Regulatory exposure.** Conditioning identity access on token purchase in some jurisdictions may attract scrutiny regarding whether the token constitutes a security and whether the platform is operating as a token-gated service with associated licensing requirements. This warrants specific legal review before implementation.
- **The balance check is a registration-time snapshot, not a continuous requirement.** After the DID is issued, the user can sell all MJN tokens. The economic stake is proof-of-purchase, not proof-of-holding. If continuous holding is required, that creates a lockup structure with its own regulatory and UX implications.

---

## Comparison

| | Pathway 1 — Member Invitation | Pathway 2 — Solana + MJN |
|---|---|---|
| **Trust signal** | Social (vouched by a member) | Economic (on-chain token holding) |
| **DID tier issued** | Preliminary | Preliminary |
| **Path to Established** | Vouch flow (Phase 2, #321) | Vouch flow (Phase 2, #321) |
| **Sybil resistance** | Invite-code social gate | Token purchase cost |
| **Crypto knowledge required** | None | Moderate to high |
| **MJN demand impact** | None | Direct: every DID = purchase |
| **Key management literacy** | Imajin educates from scratch | Inherits Solana wallet practices |
| **Wallet/identity unity** | Discovered after registration | Unified from first moment |
| **Implementation complexity** | Low (soft→preliminary upgrade needed) | Higher (wallet connect + on-chain check) |
| **Regulatory risk** | None | Requires legal review |
| **Global accessibility** | High | Dependent on exchange availability |
| **Invite gate dependency** | Yes | No |

---

## Recommendation

The two pathways address different populations and are not in conflict. A tiered approach is architecturally consistent and serves the April 1 milestone:

**For the launch:** Pathway 1 (member invitation) is the appropriate default. It requires the least new infrastructure, is accessible to everyone at the party regardless of crypto background, and preserves the social trust signal that is central to the platform's identity model.

**For the post-launch roadmap:** Pathway 2 (Solana + MJN) should be built as an alternative entry point once MJN has sufficient liquidity and the regulatory question has been assessed. It strengthens sybil resistance and directly bootstraps the token economy. It does not replace Pathway 1 — it adds an additional route to the same preliminary DID tier.

**Regardless of pathway chosen,** two actions should happen before April 1:

1. The `packages/auth/src/providers/keypair.ts:createDID()` function should be updated to match the server's `didFromPublicKey()` format, or removed. The current inconsistency produces DIDs that do not match what the database stores.

2. The backup screen (`apps/auth/app/register/page.tsx`) should acknowledge that the downloaded file is also a Solana wallet and include the conversion format (64-byte `[privateKey || publicKey]` JSON array) for users who want to import it into Phantom or Solflare. This is not new functionality — it is documentation of what is already true.

---

## Settlement Roadmap Update — 2026-03-13

The Settlement & Economics Hardening Roadmap confirms the Solana provider status: `apps/pay/lib/providers/solana.ts` is **Scaffolded** — SOL/SPL transfers, unsigned transaction returned for client signing. The pluggable `PaymentProvider` interface is live. This has direct implications for Pathway 2:

- **Pathway 2 infrastructure** is Settlement Phase 3 — the "Connect Wallet" UI and on-chain balance check require the embedded wallet surface work (Proposal 4) that is also Phase 3
- Pathway 2 cannot be production-ready before Settlement Phase 3 ships
- Pathway 1 (member invitation) remains the correct April 1 launch path

**Connection to Fee Model (Proposal 20):** A Pathway 2 registrant who purchases MJN tokens is simultaneously:
1. Getting their preliminary DID issued
2. Making their first `financial_contribution` toward the Supporter Pool $100 cap (Track 1 or Track 2 depending on amount)
3. Potentially becoming a Round 1 micro-founder if they contribute pre-revenue

The Pathway 2 MJN purchase should carry an `intent.purpose: "identity-registration"` field (from Proposal 17) and log a `financial_contribution` attestation (from Proposal 20). These happen in the same transaction. Ryan's Fee Model explicitly notes that the `financial_contribution` attestation is how cap tracking works — Pathway 2 registrants feed directly into this system.

## Open Questions for Ryan

1. **Minimum MJN threshold for Pathway 2** — fixed USD equivalent (e.g., $1) or governance-set? How is the price oracle sourced?
2. **Does the soft DID → hard DID upgrade follow Pathway 1, Pathway 2, or both?** The upgrade ceremony is currently undefined in code.
3. **Is the invite gate replaced or supplemented by the MJN gate in Pathway 2?** If both are required (invite + MJN), that is a very high barrier. If MJN alone suffices, the invite gate is removed for Pathway 2 registrants.
4. **Continuous holding vs. registration snapshot** — is the MJN balance re-checked at any point after DID issuance, and if so, what happens when it drops below threshold?
5. **Regulatory review timeline** — who is assessing the token-gated registration model before it goes into production?
