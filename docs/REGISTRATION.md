# Registering an extracted app with the kernel

Gate 1+2 of epic #2370 (#2375): an app being extracted out of the monorepo into its own
standalone repo (dykil today; links/learn/etc. later, #1985/#1991) is registered through
`apps.provision` — one call that creates its GitHub repo, registers it in the kernel's app
registry (`registry.apps`, #1990) as a **`tier: 'third_party'`** row, and seals its app-auth
private key + a GitHub-Packages-read token into the repo's Actions secrets. **The app's
private key never leaves the kernel** — it is never returned in any API response, never
logged, and never "shown once."

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

`apps.provision` acts with an **org-scoped GitHub credential** — ruled by Ryan (2026-09-24,
#2375): "the kernel does it with an org-scoped credential; no org-admin grant to
`warp-factories[bot]`, no per-app manual step by Jin." An operator seals this once via the
existing generic vault-set route:

```bash
curl -X POST "${IMAJIN_AUTH_URL}/api/vault/set" \
  -H "Content-Type: application/json" \
  -H "Cookie: <admin session cookie>" \
  -d '{
    "field": "github-org-provisioning",
    "value": "<a GitHub PAT scoped for this>",
    "custodyScheme": "delegation-grant"
  }'
```

The token needs:
- **Repo creation from a template** in the `ima-jin` org (classic PAT: `repo` + org
  permission to create repos from `ima-jin/imajin-app-template`; fine-grained: template repo
  contents:read + org Administration:write, or equivalent).
- **Actions secrets: write** on repos it provisions (to seal `IMAJIN_APP_PRIVATE_KEY` /
  `GITHUB_PACKAGES_TOKEN`).
- **`read:packages`** — this SAME token is reused, unmodified, as the sealed
  `GITHUB_PACKAGES_TOKEN` secret (see "What gets sealed, and where" below), so it must itself
  be able to read `@ima-jin/*` packages from GitHub Packages the way
  `docs/packages/PUBLISHING.md`'s consumer instructions describe.

Never sealed as a v1 field — `custodyScheme: "delegation-grant"` is required (v2 grant shape,
self-granted to the node, #2311).

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
  "secretsSet": ["IMAJIN_APP_PRIVATE_KEY", "GITHUB_PACKAGES_TOKEN"],
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

Two Actions secrets are sealed into the app's repo, by name:

| Secret name | Value |
|---|---|
| `IMAJIN_APP_PRIVATE_KEY` | The app's freshly minted Ed25519 private key (app-auth credential). |
| `GITHUB_PACKAGES_TOKEN` | The SAME org-scoped credential from "Operator setup" above, reused as-is — this is the exact env var name `docs/packages/PUBLISHING.md` documents for a consumer app's `.npmrc`. |

Both are encrypted client-side with libsodium's `crypto_box_seal` against the repo's own
Actions public key before `PUT .../actions/secrets/{name}` — GitHub's own documented
mechanism. Neither value is ever logged, returned in an API response, or persisted anywhere
outside the vault (for the private key) — `secretsSet` in every response/record is names only.

The app's DID is derived from its freshly minted public key (the same convention third-party
self-service registration already uses) — NOT the `did:imajin:app-<slug>` convention the
legacy first-party seed rows use (`migrations/0139_registry_apps_seed_first_party.sql`).
This is deliberate: it's what keeps the new row's `app_did` structurally distinct from a
pre-existing legacy first-party row's `app_did` for the same app (`registry.apps.app_did` is
globally unique) — see "Legacy first-party rows vs. provisioned apps" below.

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
4. **Seal the deploy secrets:** fetch the repo's Actions public key
   (`GET /repos/{owner}/{repo}/actions/secrets/public-key`), encrypt the private key + the
   org-scoped GitHub credential client-side with libsodium `crypto_box_seal`, and
   `PUT /repos/{owner}/{repo}/actions/secrets/IMAJIN_APP_PRIVATE_KEY` /
   `.../GITHUB_PACKAGES_TOKEN` respectively.
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
   `IMAJIN_APP_PRIVATE_KEY` / `GITHUB_PACKAGES_TOKEN` into `ima-jin/dykil`'s Actions secrets.
3. dykil's own CI/deploy on dev sets `IMAJIN_APP_DID` from the new third-party row's `appDid`
   (the response/ledger value, not the legacy placeholder) and consumes its private key +
   packages token from Actions secrets — no human touched a secret value at any point.
4. The two `dykil/*` attestation types are seeded against the NEW `appDid`, so dykil's
   survey-response ingestion is immediately namespace-valid.
5. `registry.apps` now has both rows side by side (see "Legacy first-party rows vs.
   provisioned apps" above) until the legacy row's separate retirement (#1991).
