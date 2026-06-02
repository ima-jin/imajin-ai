# Proof Model — What Is Signed, What Is Logged

> Addresses #1051 weakness 6 (Tier 2.2). This document states precisely what Imajin
> cryptographically proves versus what it merely records. The short version: **user-authored
> actions are user-signed and independently verifiable; a lot of operational state is
> platform-signed or simply logged, and we say which is which here.**

Imajin's value is the signed chain underneath the services. But not every byte that moves
through the system carries a user signature. Overstating that ("every action is verifiable")
is exactly the kind of claim a serious reviewer pulls apart. This is the honest map.

## The three categories

| Category | Who signs | Can a third party verify it without trusting the operator? |
|----------|-----------|------------------------------------------------------------|
| **User-signed** | The user's DID keypair (hard DID) | **Yes** — signature verifies against the user's published public key. |
| **Platform-signed** | The node/operator key | Only that *the operator asserted it*. You still have to trust the operator that the underlying fact is true. |
| **Logged** | Nobody (audit record) | **No** — it is operational record-keeping, not proof. |

## What falls into each

### User-signed (independently verifiable)
- **Attestations** authored by a hard-DID identity (vouches, claims, performance attestations).
- **`.fair` manifests** signed by the contributing parties' DIDs (see each `FairEntry.chainProof` / `FairSignature`).
- **Identity chain entries** the user authors with their own key (profile claims, key rotation events they sign).
- **Vault writes** encrypted and signed to a recipient's public key.

### Platform-signed (operator assertion)
- **Ticket issuance signatures** — the event node signs that a ticket was issued (`tickets.signature`). This proves *the operator issued it*, not that the holder paid in any externally-verifiable way.
- **Session attestations** for hard-DID logins — the kernel asserts a login happened.
- **Settlement receipts** the node produces after a payment clears — the operator asserts the money moved; the authoritative proof of funds lives with the payment processor (Stripe), not in our chain.

### Logged only (no cryptographic proof)
- Soft-DID activity (see below).
- Rate-limit counters, request logs, email-send records.
- Registration form answers (Dykil survey responses) — these are stored data, not signed claims.
- Anything under `metadata` JSON columns.

## The soft-DID caveat — what "bilateral" means when one side is soft

A relationship or transaction is **bilateral** in the strong (cryptographic) sense only when
**both** parties hold keypairs (hard DIDs) and sign. When one party is a **soft DID**
(email-backed, no keypair), there is no signature from that side — only:

1. A verified email (post-#1052: `verifiedAt` is set only after the magic-link flow completes), and
2. The platform's record that the soft identity acted.

So a "bilateral" interaction involving a soft DID is **operator-attested on the soft side, not
cryptographically signed**. Treat soft-DID participation as a logged claim by the platform, not
as a counter-signature. High-value or disputable actions should require a hard DID on both sides.

## Practical guidance for integrators

- If you need to prove a fact to a third party **without trusting the Imajin operator**, it must
  be **user-signed** (above). Everything else requires trusting the node.
- Payment finality is **Stripe's** record, not ours. Our settlement receipt is an operator
  assertion layered on top.
- Don't treat a soft-DID action as equivalent to a hard-DID signature.

See also: [SECURITY.md](../../SECURITY.md) · `.fair` legal boundaries: [fair-legal-boundaries.md](./fair-legal-boundaries.md)
