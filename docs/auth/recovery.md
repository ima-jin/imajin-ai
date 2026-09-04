# Key recovery (#1250)

The lost-key story: "I lost my key, prove I'm me another way, then rotate to
a fresh one." Distinct from key **management** (#1249 — "I still have my
key"). Recovery is the account-takeover surface, so it carries the auth
threat model.

Recovery is **not a new rotation mechanism**. Every recovery path terminates
in the existing #401 chain-update rotation rail. Recovery's only job is to
supply an *alternate proof of identity* sufficient to authorize that
rotation when the genesis key is gone.

## Core invariant — the user is never handed a key

Across every recovery path: **the user generates a fresh keypair locally on
their new device.** Recovery *authorizes* that fresh key; it never delivers
key material. The only thing that ever travels between parties is
**signatures and attestations**, never private keys. This sidesteps the
"how do you securely deliver a key to someone with no key" problem
entirely.

## The recovery ladder

| Situation | Recovery path | Server's role | Trustless? |
|---|---|---|---|
| Soft / email (custodial) | Re-verify email → magic link | verifies, runs clock | No — works today |
| Self-custody, no guardians | **Recovery codes** (Phase 1, this doc) | verifies code, runs clock | No (server verifies) — disclosed |
| Self-custody, fresh invitee (n=1) | Inviter co-signs + server co-signs (Phase 2) | trust participant + coordinator | No — disclosed |
| Self-custody, established (n≥3) | k-of-n guardian quorum (Phase 2) | pure coordinator | Yes |

## Phase 1 — Recovery codes (shipped)

The self-custody floor. Independent of anyone else existing — no guardians,
no inviter, no social graph required. Makes the recovery-code auth method
real: a self-custody identity can generate a batch of one-time codes ahead
of time and use one later to authorize a rotation if its key is lost.

### Ceremony

1. **Generate** — an authenticated owner (valid session, existing key) calls
   `POST /auth/api/recovery-codes/generate`. The server generates a batch of
   one-time codes (10 by default, configurable via request body or the
   `RECOVERY_CODE_COUNT` env var, clamped to 4–20), stores only a salted
   scrypt hash of each, and returns the plaintext codes **exactly once**.
   Regenerating invalidates every previously-active code in one step.
2. **Challenge** — before redeeming, the client (which has no working
   session) calls `GET /auth/api/recovery-codes/challenge?did=...` to
   obtain a short-lived, single-use challenge tied to that DID.
3. **Prove + redeem** — the client generates a fresh keypair locally, signs
   the challenge with the new key's private half (`proofOfNewKey`), and
   calls `POST /auth/api/recovery-codes/verify` with
   `{ did, code, newPublicKey, challengeId, proofOfNewKey }`. On success the
   server:
   - marks the code used and invalidates the rest of the batch,
   - rotates `identities.publicKey` to the new key (the same effect as the
     existing `/auth/api/identity/[did]/rotate` endpoint),
   - invalidates every session for the DID,
   - sends an urgent notification to the account's channels,
   - emits a `recovery.redeemed` attestation.
4. **Status** — `GET /auth/api/recovery-codes/status` (session-authenticated)
   reports how many codes are still active and when the active batch was
   generated. It never returns codes or hashes.

### Anti-takeover controls

- **Single-use, batch-invalidating.** Redeeming a code invalidates every
  other unused code from the same batch — a leaked batch is worth at most
  one rotation.
- **Rate limiting.** Both `challenge` and `verify` are rate-limited per-DID
  and per-IP; `verify` additionally logs every outcome (success or failure)
  to an append-only audit table (`auth.recovery_attempts`), including
  attempts against unknown DIDs.
- **No existence oracle.** `verify` returns the same generic 403/401 body
  for a wrong code, a reused code, and an unknown DID — a caller cannot use
  it to enumerate valid DIDs.
- **Proof of possession.** Redemption requires a signature over a
  server-issued challenge from the *new* key before the code is even
  checked, so the caller must demonstrably control the private key they are
  asking the account to rotate to.
- **Every rotation kills every session and every remaining code.** This
  applies uniformly whether the rotation came from recovery or from the
  client-signed `/rotate` endpoint.

### Honesty disclosure

A recovery code is verified **by the server** — that makes this path
server-verified, not trustless, the same trust class as an email
magic-link. This is surfaced directly in every successful API response and
in the "Recovery codes" section of account security settings. It is an
acceptable floor for any self-custody user, and the fallback of last resort
once the social recovery paths (Phase 2) are unavailable or the guardian(s)
are unreachable.

## What Phase 1 does not cover

Phase 2 (inviter co-signing at n=1, k-of-n guardian quorum at n≥3, veto
windows, all-channel ceremony notifications) is tracked under #1250 but not
implemented here — it is a substantially larger, design-heavy surface with
its own ceremony state machine and is deferred to a follow-up. Recovery
codes remain the floor underneath it: even once guardians exist, a user can
always fall back to a code if the social path is unavailable.

## Where the code lives

- `apps/kernel/src/lib/auth/recovery-codes.ts` — code generation, hashing,
  redemption, and status lookup.
- `apps/kernel/src/lib/auth/emit-recovery-attestation.ts` — the
  `recovery.codes.generated` / `recovery.redeemed` mechanical attestations.
- `apps/kernel/app/auth/api/recovery-codes/{generate,challenge,verify,status}/route.ts`
- `apps/kernel/app/auth/security/page.tsx` — the account-settings UI.
- `apps/kernel/app/auth/recover/page.tsx` — the public "Lost your key?" flow.
- `migrations/0116_recovery_codes.sql` — `auth.recovery_codes` and
  `auth.recovery_attempts`.
