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
| **S3. Node-issued ("mechanical") attestations** | `emit-mechanical-attestation.ts` (`session.created`, `session.device.new`, `usage.*`, `registry.app.*`, `relay.peer`, `vault.*`, `access.*`, `apps.signing-key.claimed`, ...), `emit-recovery-attestation.ts`, `pay/payment-requests/attestations.ts`, `knock.ts` (`agent.external_identity`), `app/auth/api/attestations/internal/route.ts`, admin registry mutations, and `key.rotated` itself | Stored signatures stop verifying against `identities.public_key` as soon as that row carries the new key (runbook step 8). | Anyone who resolves the node DID's key (the node DID is `relay.relay_config.imajin_did`; see §2.5). The in-repo chain verifier (`lib/retrace/repository.ts`) now falls back to the `key.rotated` history (`verifyNodeSignatureAcrossKeyHistory`). Every other verifier must use `trustedPublicKeysAt` from `@imajin/auth/key-rotation` over a verified chain. |
| **S4. Node-as-witness signatures for an identity** | `identity/[did]/sign/route.ts`, `chat/api/d/[did]/messages/route.ts` (`signMessagePayload`), `oauth/authorize` + `api/auth/authorize` + `api/auth/revoke` (`app.authorized` / `app.revoked`), `lib/auth/document-signatures.ts` | Old witness signatures stop verifying against the current node key. | **GAP.** `document-signatures.ts` verifies against the key currently in env only, so previously issued node-signed document signature tokens fail after rotation. Others resolve the node key as in S3. |
| **S5. Kernel witness / publisher signatures (vault-derived node DID)** | `getNodeSigningIdentity()` users: `notify/operator-approvals-service.ts` (witness record on `operator.approval.decided`), `consent-requests`, `inference/consent`, `usage/billed/receipt`, `loops/cycle`, `warp/loop-emit`, `github`/`access`/`vault` `approvals-execution` | Same key, but signed under the vault-derived DID `did:imajin:<first 16 hex of pubkey>`, so the **DID itself changes**. Old witness records no longer verify against the current identity; the loops publisher DID changes. | The stored `operator.approval.decided` witness record is now verified against the `key.rotated` history by `lib/auth/verify-witness-record.ts` (#2684). Other in-process verifiers use the current key only (`loops/verify-publisher-signature.ts` at ingest) and remain a **GAP** until they adopt it. The operator countersign (#2082) is signed by the *operator's* key and is unaffected. |
| **S6. FAIR manifests and settle receipts** | `lib/kernel/sign-fair-manifest.ts`, `lib/media/create-asset.ts`, `manifest-helpers.ts`, `content-signer.ts`; receipts: `lib/media/settle.ts`, `settle/confirm/route.ts`, `packages/fair/src/receipt.ts` | Receipts minted before the swap fail verification (streaming 24 h, other actions 30 d); buyers re-settle. `.fair.json` manifests on disk keep a signature by the old key. | **GAP.** Current key only. No re-sign sweep exists for manifests. |
| **S7. DFOS content chain (federation)** | `lib/auth/dfos.ts` (`createAttestationEntry`), `packages/dfos/src/content-publish.ts` (uses `AUTH_PRIVATE_KEY` when `DFOS_PRIVATE_KEY_HEX` is unset) | New entries signed by the new key are rejected by relays/peers until the node's DFOS identity chain registers that key (a chain `update`, `updateIdentityChain` in `packages/dfos/src/bridge.ts`). This is the "re-announce" step. | Peers and the relay, via the DFOS chain, which keeps key history natively. `key.rotated` is not needed for this role. If the node has no DFOS identity chain, `createAttestationEntry` already skips with a warning and there is nothing to re-announce. |

S2 also covers detached kernel-to-app callback signatures (#2798):
`apps/kernel/src/lib/auth/kernel-webhook.ts` signs payment, subscription and
bus settlement callbacks with the same published key. `@ima-jin/auth`
`verifyKernelWebhook` caches verified publication sets for a bounded TTL, requires
overlap by both kid and public key, and accepts currently published non-expired
keys during grace and binds each delivery to its recipient app DID. Unlike corpus's boot reconciliation, apps do not need a restart
or a key-file/env edit during an overlapping rotation. See `kernel-webhooks.md`.

S3 also covers DNS domain evidence (#2902):
`apps/kernel/src/lib/domains/signing.ts` verifies the configured node DID's
registered public key before using `AUTH_PRIVATE_KEY` for DNS verification
and revocation attestations. Historical domain evidence needs the same
verified `key.rotated` history as other S3 records; DNS rechecks preserve the
original signed verification record rather than silently re-signing it.
Imajin-issued subdomain evidence instead uses the pinned organization's own
vault-granted key, never the node key. Node rotation still requires preserving
that vault grant through the custody steps below.
Group signing-key custody (#2934) uses
`apps/kernel/src/lib/vault/group-key.ts`: it refuses missing node signing
configuration rather than accepting the deterministic dev fallback, and reuses
D2/D3 custody plus S3 audit preparation. Its `vault-group-key:*` fields are
never plaintext-exported by the legacy rotation sweep. Before rotating the
node key, countersign revocation of each group purpose grant; after rotation,
countersign fresh custody from the group's original server-encrypted key.
Keep the independent group-encryption secret unchanged. If that source cannot
be authenticated, stop: do not export a seed or invent a replacement.

SSH CAs (#3063) use `apps/kernel/src/lib/vault/ssh-ca.ts`: the CA Ed25519
key is independently minted by `vault.mint`, not derived from the node key.
Its sealed custody still depends on D2/D3, and its lifecycle receipts use S3.
Protected `vault-ssh-ca:*` fields never enter generic fetch, grant renewal or
rotation export. CA rotation itself is the vault action
`POST /api/vault/ssh-ca/rotate` plus a trust-file deploy, not a key-export
runbook. If the node root is replaced, use that action to mint a usable new
CA under the new custody root; old public trust overlaps for the shared
maximum certificate TTL, then disappears on the next trusted-keys read.
Never move a CA seed through the node rotation handoff.

SSH signing (#3064), `apps/kernel/src/lib/vault/ssh-cert.ts`, uses D2/D3 to
open the live node-only CA custody grant in-process and S3 for issuance,
refusal and operation-grant attestations. Operation grants contain no CA key
material; their principal/command/host scope is signed by the node root.
Replacing that root invalidates the old operation grants as well as custody.
Grant signing authority for the replacement CA through the vault grant route;
never re-sign a stored scope implicitly or move a private key through a shell.

Issuance records bind job, grantee, principal, host, TTL, serial, keyId, caId,
grantId and `publicKeyFingerprint`: the OpenSSH `SHA256:...` fingerprint of
the caller's throwaway public wire key, not the key material. Anonymous signing
requests return 401 without signing or storing refusal records. Authenticated
refusals retain their signed audit. Each grant may issue at most 10 certificates
in a rolling 60-second window (`SSH_CERT_ISSUANCE_LIMIT` /
`SSH_CERT_ISSUANCE_WINDOW_SECONDS`). The signing transaction counts that grant's
existing issuance events under its locks before signing, so concurrent requests
cannot exceed the budget. Excess requests return 429, record an authenticated
refusal, and return no certificate. No separate rate-limit store or config exists.

### 2.2 Derived-secret roles (HKDF / HMAC; nobody outside the process can verify these)

| Role | Consumers | What breaks on rotation | Who can read the old material |
|---|---|---|---|
| **D1. Vault seal key** (AES-256-GCM, `deriveSealKey`) | `vault/sealing.ts` `getSealKey()`; `packages/vault-core/src/seal.ts`; all v1 `node-sealed` entries; `scripts/demo/vault-client.ts` (demo only: seals with the same derivation into an in-memory store, so nothing persists across a rotation) | Every remaining **v1** entry becomes undecryptable. The sweep covers delegation-grant (v2) fields only. | Only the old key. Therefore v1 fields must be migrated to v2 before rotating (`scripts/migrate-vault-custody.mjs`, see `docs/vault-custody-migration-runbook.md`). |
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
  independent secrets.
- **`internal-secret:*` vault fields** (`ATTESTATION_INTERNAL_API_KEY`, the cron
  secret, the foreign-principal pepper, ...) are *not* simply carried by the sweep.
  The sweep re-seals the **field**, but `getInternalSecret` finds its claim by
  `(ownerDid, purpose)` where `ownerDid` is the vault-derived node DID (D2), which
  **changes with the key**, and the sweep never touches
  `kernel.internal_secret_provisions`. Any resolution between the restart and the
  Phase 2 reimport (the kernel does one at boot, for `ATTESTATION_INTERNAL_API_KEY`)
  takes the first-boot path for the new DID and **generates a fresh value**. The runbook
  therefore restarts the kernel a **second** time after the reimport, when the new DID
  finds the reimported field and *adopts* it instead of generating (#2446); the test
  that pins this is `apps/kernel/src/lib/vault/__tests__/internal-secret.test.ts`
  ("node key rotation (#2081)"). Until that second restart, internal calls that
  depend on those secrets can fail; that window is expected and short.

### 2.5 Where the node DID comes from

Every node-issued attestation, the identity row that verifies it, and the
`key.rotated` chain are keyed by the **node DID**. It is
`relay.relay_config.imajin_did` (written by `scripts/bootstrap-node-identity.ts`).
`getNodeDid()` falls back to the **`RELAY_DID`** env var when that row is unset, but
`RELAY_DID` is the DFOS relay's identity (§2.4), a different identity with a different
key. If the node DID resolves through that fallback, node-issued attestations carry the
relay DID and the step 8 `UPDATE auth.identities` would rewrite the **relay identity's**
key, contradicting §2.4. So:

- `GET /api/admin/keys/rotation` (shown on `/admin/keys`) reports `node DID` with
  its **source** and **fails** unless the source is `relay_config`.
- `POST /api/admin/keys/rotation` (`submit`) refuses with 409 under the same condition.
- Take `NODE_DID` for step 8 from that output, never from `RELAY_DID`.

## 3. The `key.rotated` attestation

Registered in `ATTESTATION_TYPES` and `MECHANICAL_ATTESTATION_TYPES`
(`packages/auth/src/types/attestation.ts`). Node-issued only: both
`POST /auth/api/attestations` and `POST /auth/api/attestations/internal` answer 403 for it
(the internal route signs with the node key under whatever `issuer_did` the caller names,
so a junk `key.rotated` filed there would break the chain for everyone). The only way in
is `POST /api/admin/keys/rotation`.

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

Roles are rotated in dependency order. Steps 3 and 6 are the two-phase vault sweep
(#1400); step 4 is the fail-closed boot gate (#1520); step 7 is the second restart that
settles the internal secrets (§2.4).

Conventions: private keys stay in the operator-controlled env file and its
0600 rollback backup; the CLI reads both **in-process**. Never copy keys,
cookies, process environments or vault plaintext into shell variables, command
lines, logs or transcripts. Use `/admin/keys` in a normal same-origin browser
session for all admin requests; log in again after restart if needed. Do not
extract a cookie or widen authorization. The CLI's environment-key and
cookie-based modes remain for legacy compatibility, not this operator runbook.

**Restart rule for steps 4 and 7.** Restart `prod-jin` from the ecosystem file with
`./scripts/pm2-reconcile.sh "$ECOSYSTEM_FILE" prod-jin`. Do **not** use
`pm2 restart prod-jin` (it reuses the saved definition and drops `--env-file`, which is
#1520), and do **not** run the deploy (`deploy-prod.yml`) for these two restarts: the
deploy runs `provision-service-bootstrap`, which touches vault grants and internal
secrets while the node DID is changing. Provisioning happens once, in step 7, after the
internal secrets have settled.

### Step 0. Go / no-go

- [ ] Off-peak. Everyone is logged out at step 4 (S1) and in-flight connects fail (D4).
- [ ] **v1 vault entries: zero.** In `/admin/keys`, click **Check v1 custody**.
      This calls `POST /api/vault/migrate-custody` with `{dryRun:true}` using
      the browser session. Confirm `totalV1Fields` is 0 and the check is not
      aborted; otherwise D1 destroys them. If migration is required, complete its separately approved custody
      procedure first; do not copy a browser cookie into the legacy migration CLI.
- [ ] Backups: the vault file at `VAULT_PATH` (`~/.imajin/vault.prod.json`), a DB
      snapshot, and under Tier 1 `imajin vault backup` and the owner agent online.
- [ ] The current env file is readable by the operator; generation retains its
      **old** key in the adjacent rollback backup until step 12.
- [ ] You know whether the node has a DFOS identity chain (S7).

### Step 1. Browser baseline before generation

Open `/admin/keys` in the kernel origin's browser session and run baseline
verification **before generate**, with the old key still loaded.

- [ ] `node DID` is shown with `source: relay_config` (§2.5). Record that DID as
      `NODE_DID`. A `RELAY_DID` source fails the check: fix
      `relay.relay_config.imajin_did` before going further.
- [ ] No error about `identities.public_key`. A mismatch means the node's identity row
      never carried the key in `AUTH_PRIVATE_KEY`; resolve that first, because step 8 and
      the final verify assume it did.
- [ ] Retain the old **public** key from generate's output in step 2 as the verification anchor. If there is
      already rotation history, retain the previously pinned genesis anchor
      instead: the verifier anchors the start of the whole chain, not just this
      rotation's predecessor. Only public data may be copied.

### Step 2. Generate and install the new env key (OLD process still running)

On the node host, with workspace packages built, run **before seal export**:

```bash
node -- scripts/key-rotation.mjs generate --env-file apps/kernel/.env.local --grace-hours 48
```

The `--` ends Node's own options so it does not auto-load `--env-file` before the
script can validate it. The tool generates the Ed25519 key **in-process**: do not hand-generate, paste,
echo or pass private material through shell commands, child-process environments
or an agent transcript. It reads the current key directly from the file and runs
the shared preflight to set `AUTH_PREVIOUS_PUBLIC_KEY`, `_VALID_FROM` and
`_VALID_UNTIL` together with the new `AUTH_PRIVATE_KEY`. The window starts at
generation time; restart all pinning verifiers before it ends. Output contains
only public keys, kids and status text.

The original file is retained byte-for-byte as
`apps/kernel/.env.local.key-rotation.bak`. Both files have mode **0600**;
installation uses a same-directory temporary file and atomic rename, preserving
every unrelated line. Run only in an operator-controlled directory. Duplicate
rotation assignments, symlinks, nonregular files, missing/invalid current keys
and existing backups fail closed. On failure inspect file **status**, never dump
contents: a backup may already exist, and must not be blindly overwritten.
Failed backup writes are removed before installation; if storage errors also
prevent cleanup, the leftover backup may be incomplete and is not safe rollback.
Before step 6, rollback is restoring this backup as `.env.local` and restarting
per the restart rule; neither key needs to enter a shell variable. Retain the
backup until the handover has been signed and all destruction gates in step 12
have passed. **Do not restart yet**: the running old kernel must seal the handoff
to the newly generated public key first.

Optional offline pair check (new key from the file, old key from its backup):

```bash
node -- scripts/key-rotation.mjs preflight --env-file apps/kernel/.env.local --grace-hours 48
```

Both file-mode commands fail closed on missing or malformed keys, duplicates,
unsafe files and crypto/filesystem failures without echoing inputs. Preflight
checks the pair only; it does not rewrite or extend the installed grace window.

### Step 3. Phase 1 sweep: seal export to the NEW public key

Copy only the **new public key** from generate's output into `/admin/keys`.
While the **old kernel is still running**, request export. The browser sends
`POST /api/vault/rotation-sweep` with
`{phase:'export',newPublicKey:<64 hex Ed25519 pub>}`.
The response is only `{exported:number,newPublicKey:string}`: record the count
and confirm the recipient equals generate's public key. No fields or plaintext
are accepted or returned. The encrypted handoff stays server-side adjacent to
the environment-specific `VAULT_PATH`, surviving the restart. An existing
handoff must not be overwritten; recover it before attempting another export.

**Sealed handoff design and limits (#2987).** The kernel exclusively creates
`<resolved VAULT_PATH>.key-rotation.sealed` with mode **0600**, writes only
ciphertext plus public metadata/signature, and fsyncs it before reporting
success. Keep the same `VAULT_PATH` on persistent, operator-controlled storage
across restarts; changing or losing that volume loses the handoff. No database
table or migration is needed. The maximum encoded handoff is **16 MiB**; an
oversized export fails before writing.

Encryption uses an ephemeral X25519 sender, standard Ed25519-to-X25519
conversion of the NEW public key, a domain-separated HKDF-SHA256 key and
AES-256-GCM. This is distinct from the vault's existing HKDF-derived X25519
keys and does not change their roles. Authenticated metadata binds the storage
path, old/new public keys, version, count, nonce and ephemeral public key.
The OLD key signs that metadata and ciphertext. Reimport verifies the signature,
requires the currently loaded key to match NEW and `AUTH_PREVIOUS_PUBLIC_KEY`
to match OLD, and authenticates/decrypts the entire batch before writing fields.
Wrong keys, modified files and protected custody fields fail closed. Neither
the sealed blob nor any plaintext is returned to the browser or logged.

An exclusive, empty `<resolved VAULT_PATH>.key-rotation.sealed.lock` serializes
workers. A crash while holding it deliberately fails closed. For recovery,
stop **all** kernel workers, inspect only file status, remove **only the empty
lock file**, then restart and retry. Never dump env files, regenerate over a
pending handoff, or remove ciphertext to silence an error. A partial/invalid
handoff requires deliberate old-state recovery before step 6; after step 6
starts, preserve recovery material and roll forward only. The containing directory
and 0600 files must remain operator-controlled; this does not protect against a
compromised kernel or host.

The sweep aborts on unreadable eligible fields rather than silently skipping
them. Roles covered: D1 (v2 only), D2, D3 and eligible `internal-secret:*` fields.
**Excluded custody is not migrated:** `internal-secret:app-self:*`, pending
app-secret input, `vault-imported-key:*` and `vault-group-key:*` are not a reveal
or migration path through this sweep. Preserve their independently authorized
custody through approved non-plaintext tooling before retiring the old key.
Pending app inputs can be submitted again through `/jin`. Imported credentials
use the countersigned import rail; group keys follow the revocation/fresh
custody procedure in §2.1. Do not replace independent ownership with node-only
ownership or invent replacement secrets.

**Rollback boundary.** Before step 6 begins, restore the old env backup and
restart per the restart rule. The old custody remains authoritative; preserve
any pending ciphertext for deliberate recovery, not blind regeneration.

### Step 4. Restart with the fail-closed boot check (#1520)

Restart per the restart rule above, log in again, and click **Verify baseline**
on `/admin/keys`. Record **Signing process started at (UTC)** as `RESTART_AT`
(ISO-8601, millisecond precision). The admin response exposes only the public
`processStartedAt` from `performance.timeOrigin`, not the process environment.
At this point history/identity checks may fail because steps 8–9 are not done;
the public process timestamp is still available. Use the first new-key restart
instant, not the second restart in step 7.
Never request a full process/environment dump, inspect `/proc/<PID>/environ`,
or print env files. Everything the old
process signed happened before it; everything the new process signs happens after it.

What the boot check does and does not give you: in production the kernel throws
rather than mint tokens (`jwt.ts`) or touch the vault (`sealing.ts`) without
`AUTH_PRIVATE_KEY`, and the pm2 start fails loudly, so a **missing** key is caught. It
cannot tell a **wrong** key from the right one; the gates below do.

- [ ] The log line `Vault signing identity derived` (written on first vault use, which
      boot triggers) shows a **new** `senderDid` and `devFallback: false`.
      `devFallback: true` means STOP and roll back.
- [ ] `GET /auth/.well-known/kernel-signing-key`: `current` is the new kid and the old
      key is listed with its `validUntil`.
- [ ] A fresh login works (S1).

Expect, and do not treat as failure: one `vault.secret.generated` attestation per
internal secret resolved at boot (§2.4). Step 7 reconciles them.

If any gate fails and step 6 has **not** started, roll back (old `.env.local`, restart
per the restart rule).

### Step 5. Sign the handover offline, at the restart instant

```bash
node -- scripts/key-rotation.mjs sign --env-file apps/kernel/.env.local \
  --effective-at "$RESTART_AT" > key-rotated.json
```

`--effective-at` is **required** (there is no "now" default): it must be the step 4
restart instant. Signing earlier, e.g. before the swap, would make history say the new
key was signing while the old process was still issuing attestations, and every one of
those would later verify as invalid. Signing later is fine as long as `--effective-at`
is `RESTART_AT`.

The script runs the same preflight, signs the rotation statement with **both** keys, and
prints only the public payload to stdout (status goes to stderr). It reads NEW
from the env file and OLD from `<env-file>.key-rotation.bak` through the same
hardened reader as generate, ignoring legacy shell keys in this mode. The
kernel never receives a private key and rejects an `effectiveAt` in the future.

### Step 6. Phase 2 sweep: reimport (NEW key loaded)

Reopen `/admin/keys` and log in normally after restart. The page recovers the
pending operation with `GET /api/vault/rotation-sweep`, returning
`{pending:boolean,exported?:number,newPublicKey?:string}` under the same admin
authorization. Compare the public recipient/count to step 3. Reimport sends
only `POST /api/vault/rotation-sweep` with `{phase:'reimport'}`: the new kernel
opens the server-held handoff and responds only `{resealed:number}`.

- [ ] `resealed` equals the step 3 count and refreshed status is `pending:false`.
      Every field must read back under the new key before success removes the
      handoff. A partial failure retains the complete ciphertext for retry;
      already-readable equal-value fields are not re-sealed again. Under Tier 1,
      a pending owner-agent grant causes failure with the handoff retained:
      wait for the authorized owner to fulfill it, then retry. No plaintext fields travel through the
      browser, shell, uploaded payload or transcript.

**Roll-forward only from here.** Phase 2 has superseded the old grants.

### Step 7. Second restart: settle the internal secrets, then provision

The kernel process is still holding whatever it generated at the step 4 boot. Restart it
again per the restart rule so every internal secret is re-resolved against the
reimported field:

- [ ] Logs show, per internal secret, the #2446 adoption WARN `no purpose-tagged grant,
      but the field is readable — re-tagged the existing grant and kept its value`, and
      **no** ERROR containing `nothing readable left`. That ERROR means a fresh secret
      was generated over unreadable material: stop, the named grantees hold a stale key.
- [ ] No further `vault.secret.generated` attestation is minted by this restart.
- [ ] Exercise a custody-backed operation for each consumer without revealing
      its secret, and confirm an internal call that depends on
      `ATTESTATION_INTERNAL_API_KEY` works (a userspace service can emit an attestation).

Now provisioning is safe. Run it (idempotent), or run the deploy
(`gh workflow run deploy-prod.yml -f ref=main`, gated by the `production` reviewer, which
also runs it):

```bash
node --env-file=apps/kernel/.env.local scripts/provision-service-bootstrap.mjs --all --env prod
```

The sweep re-seals every field under the new node identity, so grants other DIDs held on
those fields may no longer resolve; provisioning is the idempotent path that (re-)issues
them. Then **restart corpus** inside the grace window (S2) so it adds the new key to its
pin and re-reads its secrets. Corpus on `CORPUS_KERNEL_PUBLIC_KEY` must have that variable
updated instead; if the window was missed, set `CORPUS_KERNEL_PUBLIC_KEY_REPIN=1` for
exactly one boot. Confirm a corpus read succeeds.

### Step 8. Re-announce: node identity row and DFOS chain

- [ ] Update the node identity row so node-issued signatures resolve to the new key
      (S3/S4). `NODE_DID` is the one step 1 printed with `source: relay_config`. Never
      use `RELAY_DID` (§2.5):
      ```sql
      UPDATE auth.identities SET public_key = '<NEW_PUBLIC_KEY_HEX>', updated_at = now()
      WHERE id = '<NODE_DID>';   -- must affect exactly 1 row
      ```
- [ ] **Only if the node has a DFOS identity chain** (S7): publish a chain `update` that
      replaces the auth key with the new one, signed by the chain's controller key
      (`updateIdentityChain`, `packages/dfos/src/bridge.ts`), ingest it at the local
      relay, and let peers re-fetch. This needs the old key if it is the controller, so do
      it **before** step 12. There is no node-side script for this yet (§7).
- [ ] The relay identity (`RELAY_DID`) needs nothing (§2.4).

### Step 9. Record the handover: `key.rotated` (machine-checked)

In `/admin/keys`, upload the public `key-rotated.json` created in step 5 and
submit the handover after reimport and the identity-row update. Authentication
uses the normal same-origin browser session, not a copied cookie.

`POST /api/admin/keys/rotation` re-verifies both signatures, requires `newKid` to be the
key the node is signing with right now (so a wrong-key boot fails here), requires the node
DID to come from `relay_config` (§2.5), refuses a duplicate, a fork or a reused key, and
files the node-issued attestation. `key.rotated` can be filed **only** here: both
`POST /auth/api/attestations` and `POST /auth/api/attestations/internal` answer 403 for it.

### Step 10. Verify the whole chain (machine-checked)

In `/admin/keys`, enter the pinned **public** anchor from step 1 and verify.
The browser requests `GET /api/admin/keys/rotation?anchor=<PUBLIC_KEY_HEX>`.

`GET /api/admin/keys/rotation` reports whether every `key.rotated` this node
issued verifies (both signatures each, one linear chain), that the chain starts at the anchor and
ends at the loaded key, that the node DID source is `relay_config`, and that
`identities.public_key` for the node DID equals the loaded key.

### Step 11. Post-rotation checks

- [ ] An attestation the **old** process issued (before `RESTART_AT`) still shows
      `signature: verified` in Retrace (key-history fallback), and so does one issued after.
- [ ] Grace window expires on its own; remove the `AUTH_PREVIOUS_PUBLIC_KEY*` lines from
      `.env.local` afterward.

### Step 12. Destroy the old private key

Only after the rotation, custody checks and handover verification have passed:

```bash
node -- scripts/key-rotation.mjs destroy --env-file apps/kernel/.env.local
```

This removes `apps/kernel/.env.local.key-rotation.bak` without reading or printing
its key material; the current env file is untouched. Removal is not a guarantee
of physical erasure on SSDs, copy-on-write filesystems or snapshots. Retire every
other old-key copy through its custody tooling (secret-manager versions, storage
backups/snapshots and any legacy operator environment/history), never by pasting
or echoing private material. Keep the old **public** key: it is the anchor for
`verify --anchor` and for any external verifier that pinned it.

### Gate summary

| Gate | Check | Failure means |
|---|---|---|
| Step 1 | browser baseline before generate | node DID from the `RELAY_DID` fallback; identity row never matched the key |
| Step 2 | `generate --env-file`; optional `preflight --env-file` | unusable pair, unsafe file or existing rollback backup |
| Step 3 | browser export count and new public recipient; fail on any unseal error | vault is not readable with the old key; wrong recipient |
| Step 4 | `senderDid` changed + `devFallback:false`, well-known `current`, login | wrong or missing key; roll back |
| Step 5 | `sign` requires `--effective-at` and runs preflight | stale or missing instant; unusable pair |
| Step 6 | `resealed == exported` | vault not fully carried over |
| Step 7 | adoption WARN per secret, no `nothing readable left` ERROR, no new `vault.secret.generated`, internal call works | an internal secret was regenerated; consumers hold a stale key |
| Step 9 | `submit` accepts only a payload whose new key is the loaded key and whose node DID is from `relay_config` | wrong key loaded, stale payload, or relay-identity DID |
| Step 10 | `verify --anchor` | broken chain, un-attested rotation, identity row mismatch, or relay-identity DID |

## 5. Split decision: do witness/log and identity need different cadences?

**Decision: no split.** The runbook gives no reason for the two to differ, though it does expose verifier work that must land first:

1. **They share one trigger.** The reasons to rotate (compromise of the kernel
   environment, operator turnover, hygiene) all burn the single env secret, so every
   role rotates together. No step of §4 rotates a subset.
2. **The witness/log role's rotation cost is bounded, and is not a cadence driver.**
   The usual argument for a slower log cadence is that old signatures must stay
   verifiable for ever. `key.rotated` supplies the *record* that makes that possible
   (one attestation plus `trustedPublicKeysAt`), but the *verifiers* are not all there
   yet: only Retrace (S3) and the S5 witness-record verifier (`verify-witness-record.ts`,
   #2684) consume the history today, and node-as-witness signatures (S4), FAIR receipts
   (S6) and the loops publisher check remain gaps (§7). Until those verifiers adopt it, a rotation leaves those records
   unverifiable. That is a fixed, one-time piece of verifier work per consumer, the same
   whatever the cadence; it is a reason to finish §7, not a reason to run the log key
   on a different schedule from the identity key.
3. **The expensive role is neither of them.** Identity/session rotation costs a
   global logout; witness/log costs one attestation; the vault sweep (D1–D3, sealed
   handoff and reimport) is what makes rotation heavy. A split motivated by cadence
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
  (`@imajin/auth/key-rotation`) are the building blocks; Retrace and the S5 witness-record
  verifier (`verifyWitnessRecord` / `verifyOperatorApprovalWitnessRecord`, #2684) consume
  them today. The S5 verifier is a library function: nothing calls it from a route or job yet.
- **Corpus TOFU** adds a new key because it shares a kid with the pin. It could instead
  require a verified `key.rotated` from old to new, which would also remove the
  "restart inside the grace window" constraint.
- **Node DFOS chain rotation has no node-side script** (step 8). `updateIdentityChain`
  exists; the operator wiring does not.
- **`verify-email` falls back to the literal string `dev-verify-key`** when
  `AUTH_PRIVATE_KEY` is unset (`profile/api/contact/verify-email{,/confirm}/route.ts`).
  Unlike `jwt.ts` and `sealing.ts` it has no production guard (#1520 class).
- **Witness-DID key history** (`witness-jws.ts`, `operator-countersign.ts`): those
  verify a *user or operator DID's* current key. `key.rotated` covers the **node's** key
  only; history for a user/operator DID that rotated via `identity/:did/rotate` is
  separate work.
- No automatic or scheduled rotation exists; every step above is operator-driven.

## 8. Inventory manifest (checked by a test)

`scripts/__tests__/node-key-inventory.test.mjs` walks the repo for non-test code that
references `AUTH_PRIVATE_KEY`, `deriveSealKey`, `getNodeSigningIdentity`, `getSealKey` or
`getNodeX*` / `getOwnerX*`, and fails if any file is missing from this list, or if a
listed file no longer exists or no longer references any of them. Adding a consumer means
adding it here with its role from §2 (or `not a consumer`, with the reason). One line per
file: ``- `path` — role``.

- `apps/kernel/src/lib/auth/jwt.ts` — S1
- `apps/kernel/src/lib/kernel/corpus-access-claim.ts` — S2
- `apps/kernel/src/lib/auth/kernel-signing-key.ts` — S2
- `apps/kernel/src/lib/auth/kernel-webhook.ts` — S2 (detached app callbacks; published key and overlapping rotation)
- `apps/kernel/app/auth/.well-known/kernel-signing-key/route.ts` — S2
- `apps/corpus/src/middleware/access-claim.ts` — S2 (verifier; public keys only)
- `apps/kernel/src/lib/auth/emit-mechanical-attestation.ts` — S3
- `apps/kernel/src/lib/auth/revoke-agreement.ts` — S3 (requires configured node signing; prepares a canonical node-witnessed `agreement.revoked` event atomically with the retained agreement tombstone)
- `apps/kernel/src/lib/domains/signing.ts` — S3 (DNS domain verification/revocation; organization issuance uses its own vault-granted key)
- `apps/kernel/src/lib/auth/emit-recovery-attestation.ts` — S3
- `apps/kernel/src/lib/pay/payment-requests/attestations.ts` — S3
- `apps/kernel/src/lib/auth/knock.ts` — S3
- `apps/kernel/app/auth/api/attestations/internal/route.ts` — S3
- `apps/kernel/app/api/admin/registry/apps/route.ts` — S3
- `apps/kernel/app/api/admin/registry/apps/[appId]/revoke/route.ts` — S3 (operator-only Clear; node-signed registry.app.revoked receipt commits atomically with the retained app tombstone)
- `apps/kernel/src/lib/auth/node-key-rotation.ts` — S3
- `packages/auth/src/key-rotation.ts` — S3
- `packages/auth/src/types/attestation.ts` — S3
- `scripts/key-rotation.mjs` — S3
- `scripts/lib/key-rotation-cli.mjs` — S3
- `apps/kernel/app/auth/api/identity/[did]/sign/route.ts` — S4
- `apps/kernel/app/chat/api/d/[did]/messages/route.ts` — S4
- `apps/kernel/app/oauth/authorize/route.ts` — S4
- `apps/kernel/app/api/auth/authorize/route.ts` — S4
- `apps/kernel/app/api/auth/revoke/route.ts` — S4
- `apps/kernel/src/lib/auth/document-signatures.ts` — S4
- `apps/kernel/src/lib/notify/operator-approvals-service.ts` — S5
- `apps/kernel/src/lib/jin/session-commands.ts` — S5 (short-lived loop-addressed command grants; a separate full principal wish is always required, and rotation invalidates prepared grants)
- `apps/kernel/src/lib/auth/verify-witness-record.ts` — S5 (verifier; consumes the `key.rotated` history)
- `apps/kernel/src/lib/notify/operator-countersign.ts` — S5 (mention only; the countersign is the operator's key)
- `apps/kernel/src/lib/consent-requests/consent-requests.ts` — S5
- `apps/kernel/src/db/schemas/consent-requests.ts` — S5 (mention only)
- `apps/kernel/src/lib/inference/consent.ts` — S5
- `apps/kernel/src/lib/inference/resolve.ts` — S5
- `apps/kernel/src/lib/usage/billed/receipt.ts` — S5
- `apps/kernel/src/lib/loops/cycle.ts` — S5
- `apps/kernel/src/lib/loops/emit.ts` — S5 (signed native loop lifecycle observations)
- `apps/kernel/src/lib/loops/surface-conflict.ts` — S5 (node-witness-signed advisory collision observations, #2405)
- `apps/kernel/src/lib/loops/authorize-publisher.ts` — S5
- `apps/kernel/src/lib/loops/verify-publisher-signature.ts` — S5
- `apps/kernel/src/lib/warp/loop-emit.ts` — S5
- `apps/kernel/src/lib/auth/reach-delivery.ts` — S5 (node-signed reach delivery events; delivery attestations use S3 preparation)
- `apps/kernel/src/lib/github/approvals-execution.ts` — S5
- `apps/kernel/src/lib/access/approvals-execution.ts` — S5
- `apps/kernel/src/lib/vault/approvals-execution.ts` — S5
- `apps/kernel/src/lib/kernel/sign-fair-manifest.ts` — S6
- `apps/kernel/src/lib/media/create-asset.ts` — S6
- `apps/kernel/src/lib/media/manifest-helpers.ts` — S6
- `apps/kernel/src/lib/media/content-signer.ts` — S6
- `apps/kernel/src/lib/media/settle.ts` — S6
- `apps/kernel/app/media/api/assets/[id]/settle/confirm/route.ts` — S6
- `packages/fair/src/receipt.ts` — S6
- `apps/kernel/src/lib/auth/dfos.ts` — S7
- `packages/dfos/src/content-publish.ts` — S7
- `packages/vault-core/src/seal.ts` — D1
- `packages/vault-core/src/index.ts` — D1
- `scripts/demo/vault-client.ts` — D1 (demo only)
- `scripts/demo/tripian-shadow-walkthrough.ts` — D1 (demo only)
- `apps/kernel/src/lib/vault/sealing.ts` — D1/D2/D3
- `apps/kernel/src/lib/vault/rotation-handoff.ts` — D2/D3 (AUTH_PRIVATE_KEY consumer; server-side handoff encryption and recipient-bound reimport)
- `apps/kernel/src/lib/vault/index.ts` — D1/D2/D3
- `apps/kernel/src/lib/vault/grant.ts` — D2
- `apps/kernel/src/lib/vault/field-status.ts` — D2
- `apps/kernel/src/lib/vault/mint.ts` — D2
- `apps/kernel/src/lib/vault/ssh-ca.ts` — D2/D3/S3 (independent in-vault CA mint, node-only custody, transactional signed lifecycle; never exported by node-root handoff)
- `apps/kernel/src/lib/vault/ssh-cert.ts` — D2/D3/S3 (locked live CA custody unseal, signed SSH operation scope, issuance/refusal audit; no private-key export)
- `apps/kernel/src/lib/vault/mint-authority.ts` — D2
- `apps/kernel/src/lib/vault/import-authority.ts` — D2 (node identity comparison only; real human/group ownership remains independently checked)
- `apps/kernel/src/lib/vault/import.ts` — D2/S3 (v2 static-secret custody and node-attested, human-countersigned import/rotation)
- `apps/kernel/app/api/vault/import/route.ts` — D2 (pins Cloudflare credential consumer to this kernel node; never releases token material)
- `apps/kernel/src/lib/cloudflare/authority.ts` — D2 (node consumer identifier for verified-domain credential resolution; edge authority remains owner-granted)
- `apps/kernel/src/lib/dns/provider.ts` — D2 (node consumer identifier for the connector's existing zone-scoped DNS credential; no signing, sealing or new secret)
- `apps/kernel/src/lib/vault/cloudflare-import.ts` — D2 (checks node-only token custody against exact verified zone ownership)
- `apps/kernel/src/lib/vault/group-key.ts` — D2/D3/S3 (explicit node-key configuration gate; countersigned group-to-node custody, wrapped-key revoke and transactional signed audit)
- `apps/kernel/src/lib/vault/internal-secret.ts` — D2
- `apps/kernel/src/lib/vault/internal-secret-revoke.ts` — D2
- `apps/kernel/src/lib/vault/internal-secret-rotate.ts` — D2
- `apps/kernel/src/lib/vault/shared-internal-secret.ts` — D2
- `apps/kernel/src/lib/vault/vault-path.ts` — D2 (mention only)
- `apps/kernel/src/lib/apps/provision.ts` — D2
- `apps/kernel/src/lib/apps/self-secrets.ts` — D2/S3 (app-scoped custody and node-signed lifecycle facts)
- `apps/kernel/src/lib/apps/secret-staging.ts` — D1 (node-sealed pending operator input; node DID binds the single-use marker, with no delegation grant before countersign)
- `apps/kernel/app/api/apps/claim/route.ts` — D2
- `apps/kernel/app/api/apps/signing-key/fetch/route.ts` — D2
- `apps/kernel/app/api/cron/vault-grant-expiry/route.ts` — D2
- `apps/kernel/app/api/vault/delegation/grant/route.ts` — D2
- `apps/kernel/app/api/vault/delegation/revoke/route.ts` — D2
- `apps/kernel/app/api/vault/delete/route.ts` — D2
- `apps/kernel/app/api/vault/grantees/[field]/route.ts` — D2
- `apps/kernel/app/api/vault/grants/pending/route.ts` — D2
- `apps/kernel/app/api/vault/grants/renewable/route.ts` — D2
- `apps/kernel/app/api/vault/list/route.ts` — D2
- `apps/kernel/app/api/vault/rotate/route.ts` — D2
- `apps/kernel/app/api/vault/set/route.ts` — D2
- `apps/kernel/app/api/vault/upgrade-custody/route.ts` — D2
- `apps/kernel/src/lib/kernel/connector-device-ticket.ts` — D4
- `apps/kernel/src/lib/kernel/connector-oauth-state.ts` — D4
- `apps/kernel/src/lib/kernel/connector-signed-payload.ts` — D4
- `apps/kernel/app/profile/api/contact/verify-email/route.ts` — D4
- `apps/kernel/app/profile/api/contact/verify-email/confirm/route.ts` — D4
- `scripts/provision-service-bootstrap.mjs` — ops
- `scripts/grant-attestation-internal-api-key.ts` — ops
- `scripts/lib/attestation-internal-api-key-grant.ts` — ops
- `scripts/lib/cron-secret-grant.ts` — ops
- `scripts/migrate-contact-to-vault.ts` — ops
- `scripts/relay-peer-admit.ts` — ops
- `scripts/setup-local.sh` — ops (dev key only)
- `deploy/ecosystem.prod.config.js` — ops (mention only; env-file wiring)
- `apps/corpus/src/lib/attestation-forwarder.ts` — not a consumer (comment: corpus never holds the key)
