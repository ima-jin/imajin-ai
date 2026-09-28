# Registering an extracted app with the kernel

Gate 1+2 of epic #2370 (#2375): an app being extracted out of the monorepo into its own
standalone repo (dykil today; links/learn/etc. later, #1985/#1991) is registered through
`apps.provision` — one call that creates its GitHub repo, registers it in the kernel's app
registry (`registry.apps`, #1990) as a **`tier: 'third_party'`** row, and seals its app-auth
private key into the repo's Actions secrets. **The app's private key never leaves the
kernel** — it is never returned in any API response, never logged, and never "shown once."

`apps.provision` always registers `tier: 'third_party'` — matching `imajin-app-template`'s own
AGENTS.md ("every app forked from this template, including Imajin's own extractions (dykil,
links, ...), registers the same way, at the same [third_party] tier"). `tier: 'first_party'`
stays reserved for the kernel's own admin surface (`POST /api/admin/registry/apps`) seeding
an in-monorepo trusted-userspace app — see "Legacy first-party rows vs. provisioned apps"
below for how the two coexist during an app's extraction.

A developer forking `ima-jin/imajin-app-template` **outside** ima-jin (a genuine third party,
not an ima-jin extraction) uses that template's own self-service `docs/REGISTRATION.md`
(`POST /api/registry/apps`) instead — a different, human-session-gated flow where the developer
holds their own keypair rather than the kernel minting and sealing it. Do not confuse the two:
`apps.provision` is for apps the kernel itself is extracting/deploying.

## Operator setup (one-time, per node)

`apps.provision` acts as a **GitHub App installation**, not a personal access token — ruled
by Ryan (2026-09-28, #2416): the `ima-jin` org does not issue GitHub PATs. This supersedes
#2375's original org-scoped-PAT shape; the credential slot (`github-org-provisioning`) is the
same vault field, just resealed with a different, non-PAT shape. Every GitHub action this
credential takes lands in the org audit log as `imajin-provisioner[bot]` — the same identity
model `warp-factories[bot]` already uses.

1. **Create the App** under the `ima-jin` org: `https://github.com/organizations/ima-jin/settings/apps`
   -> "New GitHub App". Name it `imajin-provisioner` (or similar), disable webhooks (unused).
2. **Grant repository permissions:** Administration (Read and write — creates repos from the
   template), Contents (Read and write), Secrets (Read and write — seals Actions secrets),
   Metadata (Read-only — mandatory baseline).
3. **Install the App on the org:** from the App's settings page, "Install App" -> `ima-jin` ->
   "All repositories" (new app repos are created after the install, so per-repo selection
   can't include them yet).
4. **Generate a private key** on the App's settings page ("Generate a private key") — this
   downloads a `.pem` file once. Note the **App ID** (shown on the same page) and the
   **Installation ID** (the numeric ID in the URL after installing, e.g.
   `https://github.com/organizations/ima-jin/settings/installations/<installationId>`).
5. **Seal the three values as one JSON blob** via the existing generic vault-set route:
   ```bash
   curl -X POST "${IMAJIN_AUTH_URL}/api/vault/set" \
     -H "Content-Type: application/json" \
     -H "Cookie: <admin session cookie>" \
     -d '{
       "field": "github-org-provisioning",
       "value": "{\"appId\":\"<App ID>\",\"installationId\":\"<Installation ID>\",\"privateKeyPem\":\"<contents of the downloaded .pem, newlines escaped as \\n>\"}",
       "custodyScheme": "delegation-grant"
     }'
   ```
   Never sealed as a v1 field — `custodyScheme: "delegation-grant"` is required (v2 grant
   shape, self-granted to the node, #2311). The private key never passes through chat or Jin
   — only the operator running this `curl` ever sees it.

At call time, `getInstallationToken()` (`src/lib/github/org-provisioning.ts`) signs a
short-lived RS256 JWT with the App's private key (`iss` = App ID, <=10-minute lifetime),
exchanges it for a 1-hour installation access token
(`POST /app/installations/{installationId}/access_tokens`), and caches that token in memory
until 5 minutes before it expires. The App private key and the minted installation token are
never persisted outside the vault field itself, and never logged.

## 1. Call `apps.provision` (the normal path)

`apps.provision` is an **operator-authority proposal** on the existing operator-approvals
rail (#2059/#2152/#2082) — the same rail every other repo/identity-creating mechanical action
rides. Any authenticated identity (a human, or an agent) may propose; nothing external happens
until the node operator countersigns an `approve` decision on `/jin`.

**Propose:**

```bash
curl -X POST "${IMAJIN_AUTH_URL}/api/apps/provision" \
  -H "Content-Type: application/json" \
  -H "Cookie: <your kernel session cookie>" \
  -d '{
    "slug": "dykil",
    "displayName": "dykil",
    "attestationTypes": ["dykil/survey-response", "dykil/survey-response-legacy-import"]
  }'
```

Response (`201`, or `200` if a matching proposal is already pending):

```json
{ "status": "pending", "proposalId": "appprov_..." }
```

**Operator approves** the resulting card on `/jin` (`POST /api/operator-approvals/{proposalId}/decision`
with `decision: "approve"`, countersigned). That decision is what actually runs the pipeline
(`src/lib/apps/approvals-execution.ts` → `src/lib/apps/provision.ts`).

**Poll the result** (the agent that proposed it doesn't see the decision response directly):

```bash
curl "${IMAJIN_AUTH_URL}/api/apps/provision?slug=dykil" \
  -H "Cookie: <your kernel session cookie>"
```

```json
{
  "slug": "dykil",
  "status": "succeeded",
  "appDid": "did:imajin:9f2c...",
  "repoUrl": "https://github.com/ima-jin/dykil",
  "secretsSet": ["IMAJIN_APP_PRIVATE_KEY"],
  "attestationTypes": ["dykil/survey-response", "dykil/survey-response-legacy-import"],
  "failedStep": null,
  "errorMessage": null
}
```

(`appDid` is freshly minted and public-key-derived, not the legacy `did:imajin:app-dykil`
placeholder — see "Legacy first-party rows vs. provisioned apps" below.)

### Fields

| Field | Meaning |
|---|---|
| `slug` | Short, repo-safe identifier. The repo is `ima-jin/<slug>`; this is the idempotency key. |
| `displayName` | Human-readable app name, stored on the `registry.apps` row. |
| `template` | Optional `owner/repo` to generate from. Defaults to `ima-jin/imajin-app-template`. |
| `attestationTypes` | Optional `<slug>/<type>` strings to seed (see below). |

### Idempotency and fail-closed

- **Idempotent on slug.** Re-running `apps.provision` for a slug that already succeeded
  returns the cached `{repoUrl, appDid, secretsSet}` — it does not re-create the repo, does
  not re-mint a key, and does not re-seal secrets. If the repo already exists (e.g. dykil's
  `ima-jin/dykil`, cloned/built manually before this landed), the repo-creation step is
  skipped and only registration + sealing run.
- **Fail-closed.** Any step failing leaves a `kernel.app_provisions` row with
  `status: "failed"`, `failedStep` naming exactly which step (`repo` | `mint` | `register` |
  `seal` | `attestation-types`), and an `apps.provision.failed` bus event. No half-registered
  app is ever served: the `registry.apps` row is written only after a real keypair already
  exists and is durably vault-sealed — a failure sealing the GitHub secret never leaves a
  registry row pointing at a key nothing backs.
- **Retryable.** Re-proposing after a failure resumes from whichever step didn't already
  succeed (each step checks its own completion state first).

### Attestation types (namespaced, app-owned)

Attestation types an app emits are namespaced `<slug>/<type>` (e.g. `dykil/survey-response`)
and owned by the app DID whose slug they carry — declared by the app itself, refused outside
its own slug prefix. `apps.provision`'s optional `attestationTypes` seeds the initial set via
the existing attestation-type registry (`registerAttestationType`, #1885) — the SAME mechanism
`GET`/`POST /auth/api/attestations/types` already expose, just called with `handle: slug`
instead of a human's own `identities.handle`. A type outside `<slug>/` is refused (per-type;
it never fails the rest of provisioning).

### What gets sealed, and where

One Actions secret is sealed into the app's repo, by name:

| Secret name | Value |
|---|---|
| `IMAJIN_APP_PRIVATE_KEY` | The app's freshly minted Ed25519 private key (app-auth credential). |

(Pre-#2416 this also resealed the org-scoped credential itself as `GITHUB_PACKAGES_TOKEN` —
dropped: a GitHub App installation token expires within the hour, so reusing it as a
long-lived Actions secret no longer made sense, and `imajin-app-template`'s own CI reads
`@ima-jin/*` from public npmjs, so no packages-read secret was needed at all.)

It is encrypted client-side with libsodium's `crypto_box_seal` against the repo's own
Actions public key before `PUT .../actions/secrets/{name}` — GitHub's own documented
mechanism. The value is never logged, returned in an API response, or persisted anywhere
outside the vault — `secretsSet` in every response/record is names only.

The app's DID is derived from its freshly minted public key (the same convention third-party
self-service registration already uses) — NOT the `did:imajin:app-<slug>` convention the
legacy first-party seed rows use (`migrations/0139_registry_apps_seed_first_party.sql`).
This is deliberate: it's what keeps the new row's `app_did` structurally distinct from a
pre-existing legacy first-party row's `app_did` for the same app (`registry.apps.app_did` is
globally unique) — see "Legacy first-party rows vs. provisioned apps" below.

### First boot, then every later boot: the app fetches its own signing key from the vault (#2411)

`IMAJIN_APP_PRIVATE_KEY` sealed into GitHub Actions secrets (above) is a real destination for a
CI-deployed app, but it doesn't help an app started directly on a host the operator doesn't run
CI against (e.g. a dev box, `pm2 start` by hand) — there's no honest channel to hand it a raw
private key without pasting it into a file. For that case, the SAME minted key is also granted
directly to the app's own DID in the vault (`purpose: 'app-signing-key'`), and the operator's
approval additionally issues a **one-time, ~15-minute claim code** — Ryan's 2026-09-27 ruling on
#2411: not a `/jin` copy-paste of the key itself, not an unseal CLI on the box.

#### First boot: claim code -> bootstrap keypair -> signing key

The claim code is shown **exactly once**, in a reveal banner on the `/jin` approval card right
after approval — never persisted anywhere (only its SHA-256 hash is), never returned again by
any route, including `GET /api/apps/provision?slug=`. Put it in the app's `.env.local` as
`IMAJIN_APP_CLAIM_CODE` — a bootstrap credential the file only ever needs ONCE, alongside `PORT`,
`NODE_ENV`, `IMAJIN_KERNEL_URL`, and `IMAJIN_APP_DID`. At first boot, the app mints its OWN
Ed25519 "bootstrap" keypair (a narrow-purpose credential distinct from the vault signing key),
persists it in a local keystore file (`IMAJIN_APP_KEYSTORE`, default `./.imajin/keystore.json`,
`0600`), and exchanges the claim code + the bootstrap PUBLIC key for the real signing key:

```bash
curl -X POST "${IMAJIN_KERNEL_URL}/api/apps/claim" \
  -H "Content-Type: application/json" \
  -d '{"claimCode": "claim_...", "bootstrapPublicKey": "<hex Ed25519 pubkey>", "hostHint": "dykil-standalone"}'
```

```json
{ "appDid": "did:imajin:9f2c...", "privateKey": "...", "publicKey": "..." }
```

The kernel binds `bootstrapPublicKey` to the claim (`kernel.app_signing_key_claims`), which is
what every LATER boot authenticates against — see below. No `requireAuth` session gates this
route: the claim code itself, single-use and short-lived, IS the authentication for this one
call. A second exchange attempt — whether the code was already redeemed or has simply expired —
is refused (410 Gone).

#### Every later boot: sign a fresh challenge with the bootstrap key

Once the keystore exists, the app never spends another claim code. It signs
`canonicalize({ appDid, nonce, timestamp })` with the bootstrap private key and re-fetches:

```bash
curl -X POST "${IMAJIN_KERNEL_URL}/api/apps/signing-key/fetch" \
  -H "Content-Type: application/json" \
  -d '{"appDid": "did:imajin:9f2c...", "timestamp": 1735300000000, "nonce": "<random>", "signature": "<hex sig>"}'
```

The kernel verifies the signature against the bound bootstrap public key, rejects a stale
timestamp or a replayed nonce (both `401`), and otherwise returns the same `{appDid, privateKey,
publicKey}` shape. The SDK does all of this for you — `@ima-jin/auth-client`'s
`loadAppSigningKey()` (see that package's README) picks the keystore-present vs. first-boot path
automatically.

#### Rebinding a lost keystore

If the local keystore is lost (disk wipe, redeploy to a fresh host), re-propose and re-approve
`apps.provision` for the same slug with `"reissueClaim": true` in the request body for a fresh
claim code (reuses the existing repo/key/grant — nothing is re-minted or re-created). Redeeming
the new code **revokes** the previous bootstrap key's binding, so a lost/compromised keystore can
never authenticate a fetch again.

Signed events for the full chain are on the bus: `vault.key.minted` → `vault.grant.fulfilled` →
`apps.signing-key.claimed` → `apps.signing-key.fetched` (tagged `via: 'claim'` on first boot,
`via: 'bootstrap-key'` on every later boot). None of them ever carries the claim code, the
bootstrap private key, or the signing private key.

### Legacy first-party rows vs. provisioned apps

An app mid-extraction (dykil today) has, for a time, **two** `registry.apps` rows:

| | Legacy row (e.g. `app_first_party_dykil`) | Provisioned row (`apps.provision` creates this) |
|---|---|---|
| `tier` | `first_party` | `third_party` |
| `slug` | `NULL` (deliberately excluded from `0163_registry_apps_slug.sql`'s backfill) | the provisioned slug, e.g. `dykil` |
| `app_did` | the legacy `did:imajin:app-<slug>` placeholder, with **no real private key backing it** | freshly minted, vault-sealed, public-key-derived |
| Written by | `0139_registry_apps_seed_first_party.sql` (one-time seed) | `apps.provision` |

`apps.provision` **never updates, renames, or upserts into the legacy row** — it only ever
reads/writes the row it itself owns (looked up by the freshly-minted `app_did`, never by
slug or id). The legacy row's `slug` is left `NULL` specifically so the provisioned row can
claim that slug value without violating `registry.apps`'s unique `slug` index. The two rows
coexist until the legacy row's own retirement (revoking it, or dropping it entirely) is
deliberately handled as separate cleanup — #1991, out of scope for #2375.

An app whose legacy row was NOT excluded from the slug backfill (i.e. its `slug` is already
set) cannot be provisioned yet: the INSERT in the 'register' step hits the same unique-slug
constraint and correctly fails closed at that step — provisioning intentionally refuses to
silently produce two rows answering to the same slug.

## 2. Or do these steps by hand

Only if `apps.provision` cannot be used (e.g. bootstrapping before the org credential is
sealed). Do not do this for an app `apps.provision` already owns — hand-registering fights
with the idempotency ledger.

1. **Create the repo:** `gh repo create ima-jin/<slug> --template ima-jin/imajin-app-template
   --private`. Skip if it already exists.
2. **Mint a keypair** for the app (do NOT hand-generate one — use the vault's own mint
   primitive so the private key is born sealed): `POST /api/vault/mint` with
   `{"purpose": "apps.provision:<slug>", "requesterDid": "<node DID>"}` — note that route
   requires mint authority (the node's own signing identity); prefer the
   `apps.provision` route as soon as the org credential exists.
3. **Register the app as a NEW third-party row** — do not touch any pre-existing legacy
   first-party row for the same app. `POST /api/admin/registry/apps` (admin-scoped) with
   `{"name": "<displayName>", "ownerDid": "did:imajin:platform", "callbackUrl":
   "https://your-node.imajin.ai/<slug>", "tier": "third_party", "publicKey": "<from step 2>",
   "tokenAudiences": ["<slug>"], "allowedRedirectHosts": ["<slug>"]}`. Set the row's `slug`
   column directly in the database (the admin route predates #2375's `slug` column) so future
   `apps.provision` calls treat it as idempotent. If a legacy row for this slug still has
   `slug` set, clear it first (see "Legacy first-party rows vs. provisioned apps" below) —
   `slug` is globally unique.
4. **Seal the deploy secret:** fetch the repo's Actions public key
   (`GET /repos/{owner}/{repo}/actions/secrets/public-key`), encrypt the private key
   client-side with libsodium `crypto_box_seal`, and
   `PUT /repos/{owner}/{repo}/actions/secrets/IMAJIN_APP_PRIVATE_KEY` with the result. Use a
   GitHub App installation token (see "Operator setup" above) to authenticate the two calls
   above, minted the same way `getInstallationToken()` does.
5. **Seed attestation types (optional):** `POST /auth/api/attestations/types` per type, or call
   `registerAttestationType` in-process with `handle: <slug>`.

## Worked example: how dykil registers through this on dev

Per #2370's evidence comment (2026-09-26): a standalone `ima-jin/dykil` was already cloned,
built, and Caddy-routed on dev — it hard-stopped at app registration, since
`POST /auth/api/registry/apps` needs a human session and there was no agent-callable path.
`apps.provision` is exactly the gate that unblocks it. dykil is **not provisioned at all**
on dev today: `registry.apps` has only the **legacy** first-party row `app_first_party_dykil`
(seeded by `migrations/0139_registry_apps_seed_first_party.sql` — `did:imajin:app-dykil`, a
non-functional placeholder public key, `slug IS NULL`, `tier = 'first_party'`), and the
standalone repo `ima-jin/dykil` already exists.

1. An agent proposes:
   ```json
   POST /api/apps/provision
   { "slug": "dykil", "displayName": "dykil",
     "attestationTypes": ["dykil/survey-response", "dykil/survey-response-legacy-import"] }
   ```
2. The operator approves. Because `ima-jin/dykil` already exists, the pipeline **skips repo
   creation** (idempotent/skippable). It then mints a **fresh** Ed25519 keypair (a new,
   public-key-derived DID — distinct from the legacy `did:imajin:app-dykil`) and **registers
   a brand-new `tier: 'third_party'` row** with `slug: 'dykil'` — the legacy
   `app_first_party_dykil` row is left completely untouched (still `first_party`, still
   `slug IS NULL`, still its own placeholder `app_did`). Finally it **seals**
   `IMAJIN_APP_PRIVATE_KEY` into `ima-jin/dykil`'s Actions secrets, authenticated as the
   `imajin-provisioner[bot]` GitHub App installation.
3. dykil's own CI/deploy on dev sets `IMAJIN_APP_DID` from the new third-party row's `appDid`
   (the response/ledger value, not the legacy placeholder) and consumes its private key from
   Actions secrets — no human touched a secret value at any point.
4. The two `dykil/*` attestation types are seeded against the NEW `appDid`, so dykil's
   survey-response ingestion is immediately namespace-valid.
5. `registry.apps` now has both rows side by side (see "Legacy first-party rows vs.
   provisioned apps" above) until the legacy row's separate retirement (#1991).
