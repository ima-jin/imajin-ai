# Node key roles and rotation runbook (`AUTH_PRIVATE_KEY`)

Issue #2081 (epic #2084). Prior art: #1400 (vault rotation sweep, two-phase),
#1520 (prod-jin booted without `AUTH_PRIVATE_KEY` → silent dev-seed fallback),
#1239 (custody option table), #513 (`key.rotated` attestation type — registered
by this change).

This is a runbook, not an authorization. **Executing a rotation against prod is
an operator decision made separately from this document.** Hardware custody
(secure element / TPM / Unit-as-custodian) is #1979 and out of scope here.

## 1. Why one env var is a rotation problem

`AUTH_PRIVATE_KEY` is a single Ed25519 seed in the kernel's environment
(`apps/kernel/.env.local`, loaded by pm2 via `--env-file`, see
`deploy/ecosystem.prod.config.js`). The kernel uses it directly as a signing
key, derives symmetric and X25519 keys from it with HKDF/HMAC, and exposes the
public half as the node's identity. Rotating it changes **every** role at the
same instant. The roles differ in what they cost to rotate and in whether
anyone outside the process can still verify what the old key produced.

## 2. Roles inventory

Derived by `grep -rn AUTH_PRIVATE_KEY` over `apps/ packages/ scripts/ deploy/
.github/ docs/ migrations/`, then following the indirect consumers the grep
cannot see: `getNodeSigningIdentity()`, `getSealKey()`, `getNodeXPrivateKey()`,
`getOwnerXPrivateKey()` (all in `apps/kernel/src/lib/vault/sealing.ts`). To
re-run: `grep -rnE "AUTH_PRIVATE_KEY|getNodeSigningIdentity|getSealKey|getNodeX(Private|Public)Key|getOwnerX(Private|Public)Key"` excluding tests.

Roles marked **GAP** are verifiers that still resolve only the *current* key.
They are listed honestly in §7 rather than papered over.

### 2.1 Direct signing roles (Ed25519, raw key)

| Role | Consumers | What breaks on rotation | Who verifies the old key |
|---|---|---|---|
| **S1. Session / app / session-app / MFA-challenge JWTs** | `apps/kernel/src/lib/auth/jwt.ts` | Every outstanding token stops verifying at the swap: sessions (24 h), app and session-app tokens (10 min), MFA challenges (5 min). Users re-authenticate; apps re-mint. | Nobody, by design. The kernel verifies the current key only, and userspace services validate by calling the kernel (`AUTH_SERVICE_URL`), not against a pinned key. Short TTL bounds the damage; not covered by `key.rotated`. |
| **S2. `CorpusAccessClaim`** | `apps/kernel/src/lib/kernel/corpus-access-claim.ts` (60 s TTL) | Corpus answers 401 to every claim until it trusts the new key. | Corpus, from its pinned key set (`apps/corpus/src/lib/kernel-trust.ts`). The kernel serves old + new in `GET /auth/.well-known/kernel-signing-key` while `AUTH_PREVIOUS_PUBLIC_KEY*` is set (#2244). Corpus reconciles its pin **only at boot**, and only adds the new key if the served set still shares a kid with the pin, so corpus must be restarted inside the grace window. |
| **S3. Node-issued ("mechanical") attestations** | `emit-mechanical-attestation.ts` (`session.created`, `session.device.new`, `usage.*`, `registry.app.*`, `relay.peer`, `vault.*`, `access.*`, `apps.signing-key.claimed`, ...), `emit-recovery-attestation.ts`, `pay/payment-requests/attestations.ts`, `knock.ts` (`agent.external_identity`), `app/auth/api/attestations/internal/route.ts`, admin registry mutations, and `key.rotated` itself | Stored signatures stop verifying against `identities.public_key` as soon as that row carries the new key (runbook step 7). | Anyone who resolves the node DID's key. The in-repo chain verifier (`lib/retrace/repository.ts`) now falls back to the `key.rotated` history (`verifyNodeSignatureAcrossKeyHistory`). Every other verifier must use `trustedPublicKeysAt` from `@imajin/auth/key-rotation` over a verified chain. |
| **S4. Node-as-witness signatures for an identity** | `identity/[did]/sign/route.ts`, `chat/api/d/[did]/messages/route.ts` (`signMessagePayload`), `oauth/authorize` + `api/auth/authorize` + `api/auth/revoke` (`app.authorized` / `app.revoked`), `lib/auth/document-signatures.ts` | Old witness signatures stop verifying against the current node key. | **GAP.** `document-signatures.ts` verifies against the key currently in env only, so previously issued node-signed document signature tokens fail after rotation. Others resolve the node key as in S3. |
| **S5. Kernel witness / publisher signatures (vault-derived node DID)** | `getNodeSigningIdentity()` users: `notify/operator-approvals-service.ts` (witness record on `operator.approval.decided`), `consent-requests`, `inference/consent`, `usage/billed/receipt`, `loops/cycle`, `warp/loop-emit`, `github`/`access`/`vault` `approvals-execution` | Same key, but signed under the vault-derived DID `did:imajin:<first 16 hex of pubkey>`, so the **DID itself changes**. Old witness records no longer verify against the current identity; the loops publisher DID changes. | In-process verifiers use the current key only (`loops/verify-publisher-signature.ts` at ingest). **GAP** for stored witness records until a verifier consumes the `key.rotated` history. The operator countersign (#2082) is signed by the *operator's* key and is unaffected. |
| **S6. FAIR manifests and settle receipts** | `lib/kernel/sign-fair-manifest.ts`, `lib/media/create-asset.ts`, `manifest-helpers.ts`, `content-signer.ts`; receipts: `lib/media/settle.ts`, `settle/confirm/route.ts`, `packages/fair/src/receipt.ts` | Receipts minted before the swap fail verification (streaming 24 h, other actions 30 d); buyers re-settle. `.fair.json` manifests on disk keep a signature by the old key. | **GAP.** Current key only. No re-sign sweep exists for manifests. |
| **S7. DFOS content chain (federation)** | `lib/auth/dfos.ts` (`createAttestationEntry`), `packages/dfos/src/content-publish.ts` (uses `AUTH_PRIVATE_KEY` when `DFOS_PRIVATE_KEY_HEX` is unset) | New entries signed by the new key are rejected by relays/peers until the node's DFOS identity chain registers that key (a chain `update`, `updateIdentityChain` in `packages/dfos/src/bridge.ts`). This is the "re-announce" step. | Peers and the relay, via the DFOS chain, which keeps key history natively. `key.rotated` is not needed for this role. If the node has no DFOS identity chain, `createAttestationEntry` already skips with a warning and there is nothing to re-announce. |

### 2.2 Derived-secret roles (HKDF / HMAC; nobody outside the process can verify these)

| Role | Consumers | What breaks on rotation | Who can read the old material |
|---|---|---|---|
| **D1. Vault seal key** (AES-256-GCM, `deriveSealKey`) | `vault/sealing.ts` `getSealKey()`; all v1 `node-sealed` entries | Every remaining **v1** entry becomes undecryptable. The sweep covers delegation-grant (v2) fields only. | Only the old key. Therefore v1 fields must be migrated to v2 before rotating (`scripts/migrate-vault-custody.mjs`, see `docs/vault-custody-migration-runbook.md`). |
| **D2. Vault node signing identity** (signs every vault entry; DID = `did:imajin:<pubkey[:16]>`) | `vault/sealing.ts` `getNodeSigningIdentity()`; node-held grants and `internal-secret:*` fields | `senderDid` changes, so every old entry/grant fails signature or grantee checks. This is exactly the #1520 failure mode, now caused deliberately. | Only the old key, during Phase 1. Phase 2 re-signs under the new identity. |
| **D3. Node and Tier-0 owner X25519 keys** (HKDF info `vault-node-x25519-v1`, `vault-owner-x25519-v1`) | `vault/sealing.ts`; `vault/index.ts` grant wrapping | Field keys wrapped to the old X25519 keys cannot be unwrapped. Under Tier 1 the owner X25519/Ed25519 keys are external (`VAULT_OWNER_X_PUB`/`_ED_PUB`) and unaffected; the node's own X25519 key is still derived. | Only the old key, during Phase 1; Phase 2 re-wraps. |
| **D4. HMAC-bound short-lived tokens** | `lib/kernel/connector-oauth-state.ts` (10 min), `connector-device-ticket.ts` (16 min), `connector-signed-payload.ts`, `profile/api/contact/verify-email{,/confirm}` (15 min) | In-flight OAuth connects, device-code flows and email verifications fail; the user starts over. | Nobody; accepted. Note `verify-email` falls back to a literal dev string when the env var is unset (§7). |

### 2.3 Operational readers and published surfaces

- Scripts that load the kernel env and so need the **new** key after the swap:
  `scripts/provision-service-bootstrap.mjs`, `scripts/grant-attestation-internal-api-key.ts`,
  `scripts/lib/cron-secret-grant.ts`, `scripts/migrate-contact-to-vault.ts`,
  `scripts/relay-peer-admit.ts`. `scripts/setup-local.sh` generates the **dev** key only.
- Published surfaces: `GET /auth/.well-known/kernel-signing-key` (`kernel-signing-key.ts`),
  `auth.identities.public_key` for the node DID (DID document and signature
  verification read it), `GET /registry/api/node/self`.

### 2.4 Audited and **not** consumers (no action)

- **Relay identity** (`RELAY_DID`, `RELAY_PROFILE_JWS`, served at
  `/registry/relay/.well-known/dfos-relay`): a separate keypair from
  `scripts/generate-relay-identity.mjs`. A rotation does not touch it, so there is
  no relay-identity re-announce, only the node's DFOS chain (S7).
- `MFA_ENCRYPTION_KEY`, `INTERNAL_API_KEY`, `CORPUS_DID_PRIVATE_KEY`, each
  service's `*_VAULT_BOOTSTRAP_PRIVATE_KEY`, and Tier 1 owner-agent keys are
  independent secrets. `ATTESTATION_INTERNAL_API_KEY` and the other
  `internal-secret:*` values are vault fields, so they ride the sweep (D2/D3).

## 3. The `key.rotated` attestation

Registered in `ATTESTATION_TYPES` and `MECHANICAL_ATTESTATION_TYPES`
(`packages/auth/src/types/attestation.ts`). Node-issued only:
`POST /auth/api/attestations` answers 403 for it.

Payload (public data and signatures only; the primitives live in
`packages/auth/src/key-rotation.ts`, also exported as `@imajin/auth/key-rotation`):

| Field | Meaning |
|---|---|
| `oldKid`, `newKid` | `auth-` + first 16 hex of SHA-256 of the public key hex (same kid the well-known document publishes) |
| `oldPublicKey`, `newPublicKey` | Ed25519 public keys, hex |
| `effectiveAt` | ISO-8601 instant the new key took over |
| `oldKeySignature`, `newKeySignature` | Ed25519 signatures by the old and the new key over `canonicalize({type:'key.rotated', v:1, oldKid, newKid, oldPublicKey, newPublicKey, effectiveAt})` |

Envelope: `issuerDid = subjectDid =` node DID, `contextType = 'node.key'`,
`contextId = newKid`, signed by the new key like every mechanical attestation.

Why both signatures: the old-key signature lets a verifier who pinned the old key
accept its successor; the new-key signature proves the successor is held by whoever
ran the rotation, so a stolen old key alone cannot mint a handover to a key the
thief does not hold. Chained (`verifyKeyRotationChain`: one linear history, no fork,
no reused key, non-decreasing `effectiveAt`, optional pinned anchor) the payloads
give `trustedPublicKeysAt(history, at)`: the key that was legitimately signing at
any past instant.

## 4. Rotation runbook

Roles are rotated in dependency order. Steps 3 and 6 are the same two-phase vault
sweep (#1400); step 5 is the fail-closed boot gate (#1520).

Conventions: `OLD_*` / `NEW_*` keys come from your secret manager into shell
variables and are never echoed, written to a file, or put on a command line you
paste into chat. `KERNEL_ADMIN_COOKIE` is the full `Cookie` header of a logged-in
admin session (same as `scripts/migrate-vault-custody.mjs`).

### Step 0. Go / no-go

- [ ] Off-peak. Everyone is logged out at step 5 (S1) and in-flight connects fail (D4).
- [ ] **v1 vault entries: zero.** Dry-run `node scripts/migrate-vault-custody.mjs`
      and confirm `totalV1Fields` is 0, otherwise D1 destroys them.
- [ ] Backups: the vault file at `VAULT_PATH` (`~/.imajin/vault.prod.json`), a DB
      snapshot, and under Tier 1 `imajin vault backup` and the owner agent online.
- [ ] The **old** key is available to you (it is needed in steps 2 and 3) and stays
      available until step 11.
- [ ] A corpus restart is possible inside the grace window (S2).
- [ ] You know the node DID and whether it has a DFOS identity chain (S7).

### Step 1. Preflight (machine-checked)

```bash
OLD_AUTH_PRIVATE_KEY="$OLD" NEW_AUTH_PRIVATE_KEY="$NEW" \
  node scripts/key-rotation.mjs preflight --grace-hours 48
```

Fails (exit 1) on a missing or malformed key, an identical pair, or the
publicly-known dev fallback key (#1520). Prints both kids and public keys and the
three `AUTH_PREVIOUS_PUBLIC_KEY*` values to set in step 5. Warns if the grace
window is under 24 h.

### Step 2. Sign the handover offline (before the swap)

```bash
OLD_AUTH_PRIVATE_KEY="$OLD" NEW_AUTH_PRIVATE_KEY="$NEW" \
  node scripts/key-rotation.mjs sign > key-rotated.json
```

Runs the same preflight, then signs the rotation statement with **both** keys and
prints the public payload (nothing secret). Doing this now means the old private
key never has to exist on the prod host after the swap, and the kernel never
receives a private key. `effectiveAt` defaults to now; for a rotation that will
complete within the hour that is correct. Re-run `sign` if the swap slips by more
than a few minutes (the kernel rejects an `effectiveAt` in the future, and a stale
one makes the history claim the new key was signing before it was).

### Step 3. Phase 1 sweep: export (OLD key still loaded)

```bash
EXPORT=$(curl -sS -X POST "$KERNEL_BASE_URL/api/vault/rotation-sweep" \
  -H "Cookie: $KERNEL_ADMIN_COOKIE" -H 'Content-Type: application/json' \
  -d '{"phase":"export"}')
printf '%s' "$EXPORT" | jq '.fields | length'    # record this number; never print the fields
```

Plaintext secrets are in `$EXPORT`: keep it in that shell variable only, never in a
file. The route aborts (500) if any field cannot be unsealed, so a short count
means stop and investigate. Roles covered: D1 (v2 only), D2, D3.

**Rollback boundary.** Until step 6 completes, rolling back is "restore the old
key and restart": the old vault entries and grants are still active.

### Step 4. Swap the env

On the prod host edit `apps/kernel/.env.local`:

```
AUTH_PRIVATE_KEY=<new key>
AUTH_PREVIOUS_PUBLIC_KEY=<old public key>
AUTH_PREVIOUS_PUBLIC_KEY_VALID_FROM=<from preflight>
AUTH_PREVIOUS_PUBLIC_KEY_VALID_UNTIL=<from preflight>
```

### Step 5. Restart with the fail-closed boot check (#1520)

Restart `prod-jin` **from the ecosystem file**, never `pm2 restart prod-jin` (that
reuses the saved definition and drops `--env-file`, which is #1520). Either run the
deploy (`gh workflow run deploy-prod.yml -f ref=main`, gated by the `production`
reviewer, which also re-runs the idempotent service provisioning) or run
`./scripts/pm2-reconcile.sh "$ECOSYSTEM_FILE" prod-jin` on the host.

What the boot check does and does not give you: in production the kernel throws
rather than mint tokens (`jwt.ts`) or touch the vault (`sealing.ts`) without
`AUTH_PRIVATE_KEY`, and the deploy provisions with `NODE_ENV=production`, so a
**missing** key fails loudly. It cannot tell a **wrong** key from the right one;
the gates below do.

- [ ] The log line `Vault signing identity derived` (written on first vault use, which
      boot triggers) shows a **new** `senderDid` and `devFallback: false`.
      `devFallback: true` means STOP and roll back.
- [ ] `GET /auth/.well-known/kernel-signing-key`: `current` is the new kid and the
      old key is listed with its `validUntil`.
- [ ] A fresh login works (S1).
- [ ] **Restart corpus now**, inside the grace window (S2), so it adds the new key
      to its pin. Corpus on `CORPUS_KERNEL_PUBLIC_KEY` must have that variable
      updated instead; if the window was missed, set
      `CORPUS_KERNEL_PUBLIC_KEY_REPIN=1` for exactly one boot. Confirm a corpus read
      succeeds.

If any gate fails and step 6 has **not** started, roll back (old `.env.local`,
restart from the ecosystem file).

### Step 6. Phase 2 sweep: reimport (NEW key loaded)

```bash
curl -sS -X POST "$KERNEL_BASE_URL/api/vault/rotation-sweep" \
  -H "Cookie: $KERNEL_ADMIN_COOKIE" -H 'Content-Type: application/json' \
  -d "$(printf '%s' "$EXPORT" | jq -c '{phase:"reimport", fields: .fields}')"
unset EXPORT
```

- [ ] `resealed` equals the step 3 count. The route fails loudly on any field and
      never skips, and is safe to re-run in full after a crash.
- [ ] Re-run the deploy's provisioning (`node --env-file=apps/kernel/.env.local
      scripts/provision-service-bootstrap.mjs --all --env prod`, idempotent). The sweep
      re-seals every field under the new node identity, so grants other DIDs held on
      those fields may no longer resolve; provisioning is the idempotent path that
      (re-)issues them. Confirm each consumer (e.g. corpus fetching
      `ATTESTATION_INTERNAL_API_KEY`) can still read its secret.
- [ ] No **new** `vault.secret.generated` attestation was minted after the swap. One
      means an internal secret was regenerated instead of carried over by the sweep.
- [ ] Spot-read one secret per consumer.

**Roll-forward only from here.** Phase 2 has superseded the old grants.

### Step 7. Re-announce: node identity row and DFOS chain

- [ ] Update the node identity row so node-issued signatures resolve to the new key
      (S3/S4). Use the node DID and new public key from step 1:
      ```sql
      UPDATE auth.identities SET public_key = '<NEW_PUBLIC_KEY_HEX>', updated_at = now()
      WHERE id = '<NODE_DID>';   -- must affect exactly 1 row
      ```
- [ ] **Only if the node has a DFOS identity chain** (S7): publish a chain `update`
      that replaces the auth key with the new one, signed by the chain's controller
      key (`updateIdentityChain`, `packages/dfos/src/bridge.ts`), ingest it at the
      local relay, and let peers re-fetch. This needs the old key if it is the
      controller, so do it **before** step 11. There is no node-side script for this
      yet (§7).
- [ ] The relay identity (`RELAY_DID`) needs nothing (§2.4).

### Step 8. Record the handover: `key.rotated` (machine-checked)

```bash
KERNEL_ADMIN_COOKIE="$KERNEL_ADMIN_COOKIE" KERNEL_BASE_URL="$KERNEL_BASE_URL" \
  node scripts/key-rotation.mjs submit --payload key-rotated.json
```

`POST /api/admin/keys/rotation` re-verifies both signatures, requires `newKid` to be
the key the node is signing with right now (so a wrong-key boot fails here), refuses
a duplicate, a fork or a reused key, and files the node-issued attestation. This is
the fail-closed check that the key the process loaded is the key you signed for.

### Step 9. Verify the whole chain (machine-checked)

```bash
KERNEL_ADMIN_COOKIE="$KERNEL_ADMIN_COOKIE" KERNEL_BASE_URL="$KERNEL_BASE_URL" \
  node scripts/key-rotation.mjs verify --anchor <OLD_PUBLIC_KEY_HEX>
```

`GET /api/admin/keys/rotation` (exit 1 on failure) verifies every `key.rotated`
this node issued (both signatures each, one linear chain), that the chain starts at
the anchor and ends at the loaded key, and that `identities.public_key` for the node
DID equals the loaded key. A first-ever rotation on a node whose identity row never
matched `AUTH_PRIVATE_KEY` fails here: that is a finding about the node, not a bug in
the check.

### Step 10. Post-rotation checks

- [ ] An attestation issued before the swap still shows `signature: verified` in
      Retrace (key-history fallback).
- [ ] Grace window expires on its own; remove the `AUTH_PREVIOUS_PUBLIC_KEY*` lines
      from `.env.local` afterward.

### Step 11. Destroy the old private key

Every copy: secret manager version, shell history, `.env.local` backups, the
operator's terminal environment. Keep the old **public** key: it is the anchor for
`verify --anchor` and for any external verifier that pinned it.

### Gate summary

| Gate | Check | Failure means |
|---|---|---|
| Step 1 | `key-rotation.mjs preflight` | unusable pair; do not swap |
| Step 2 | `key-rotation.mjs sign` (runs preflight) | refused to sign |
| Step 3 | export count, route aborts on any unseal failure | vault is not readable with the old key |
| Step 5 | `senderDid` changed + `devFallback:false`, well-known `current`, login, corpus read | wrong or missing key; roll back |
| Step 6 | `resealed == exported`, no new `vault.secret.generated` | vault not fully carried over |
| Step 8 | `submit` accepts only a payload whose new key is the loaded key | wrong key loaded, or stale payload |
| Step 9 | `verify --anchor` | broken chain, un-attested rotation, or identity row mismatch |

## 5. Split decision: do witness/log and identity need different cadences?

**Decision: no split.** The runbook shows the two do not need to differ:

1. **They share one trigger.** The reasons to rotate (compromise of the kernel
   environment, operator turnover, hygiene) all burn the single env secret, so every
   role rotates together. No step of §4 rotates a subset.
2. **The witness/log role's real cost is already paid by `key.rotated`.** The usual
   argument for a slower log cadence is that old signatures must stay verifiable for
   ever. With the dual-signed history, rotating the log key is one attestation plus
   a history lookup (`trustedPublicKeysAt`), not an orphaning event.
3. **The expensive role is neither of them.** Identity/session rotation costs a
   global logout; witness/log costs one attestation; the vault sweep (D1–D3, plaintext
   export and reimport) is what makes rotation heavy. A split motivated by cadence
   would split the *vault derivation root* from the signing key first.
4. **A split is not free.** The vault signing DID is a function of the public key
   (S5/D2), the node DID row carries one key, and every verifier resolves one key.
   Splitting means a second DID and issuer identity, migration of every
   node-issued attestation consumer, and a second custody story, for no cadence
   benefit the runbook demonstrates.

**Revisit when** (a) `OPERATOR_COUNTERSIGN_REQUIRED=true` is on node-wide (#2082) and
the operator-approval chain (#2084) is live, so the witness key only attests ordering
and timestamps and could sit in hardware custody (#1979) on its own slower cadence;
(b) a security-driven rotation of the signing key is wanted more often than the vault
sweep is tolerable, which argues for splitting the vault root first; or (c) federation
makes peers pin the node key, where a longer-lived log key plus a short-lived session
key would reduce churn.

## 6. Threat-model disclosure

**Node key custody class: server secret.** `AUTH_PRIVATE_KEY` lives in the kernel's
process environment, so anyone who can read that environment or the process memory
holds every role in §2 at once: the node's signing identity, the vault sealing and
delegation keys, and the session-token key. A compromised kernel can therefore forge
anything the node signs. For human-to-agent operational approvals that means: in the
shipped v1 model the kernel's own witness signature on a decision is the only proof,
so **a kernel compromise implies approval forgery until the operator's own
countersignature is required** (`OPERATOR_COUNTERSIGN_REQUIRED=true`, #2082, shipped and
off by default). **Once countersign is required, a kernel compromise can forge
timestamps (when a witnessed decision is recorded) and withhold records, but can no
longer forge an approval**, because it does not hold the operator's key. Hardware
custody that would narrow the server-secret class is #1979.

(This paragraph is mirrored in `SECURITY.md`.)

## 7. Known gaps and follow-ups

Found while building the inventory; none is introduced by this change and none is
closed by it, but each now has a concrete place to attach.

- **Verifiers that resolve only the current key** (S4/S5/S6): `lib/auth/document-signatures.ts`,
  FAIR manifest and receipt verification, `loops/verify-publisher-signature.ts`.
  `verifyNodeSignatureAcrossKeyHistory` (kernel) and `trustedPublicKeysAt`
  (`@imajin/auth/key-rotation`) are the building blocks; only Retrace consumes them today.
- **Corpus TOFU** adds a new key because it shares a kid with the pin. It could instead
  require a verified `key.rotated` from old to new, which would also remove the
  "restart inside the grace window" constraint.
- **Node DFOS chain rotation has no node-side script** (step 7). `updateIdentityChain`
  exists; the operator wiring does not.
- **`verify-email` falls back to the literal string `dev-verify-key`** when
  `AUTH_PRIVATE_KEY` is unset (`profile/api/contact/verify-email{,/confirm}/route.ts`).
  Unlike `jwt.ts` and `sealing.ts` it has no production guard (#1520 class).
- **Witness-DID key history** (`witness-jws.ts`, `operator-countersign.ts`): those
  verify a *user or operator DID's* current key. `key.rotated` covers the **node's** key
  only; history for a user/operator DID that rotated via `identity/:did/rotate` is
  separate work.
- No automatic or scheduled rotation exists; every step above is operator-driven.
