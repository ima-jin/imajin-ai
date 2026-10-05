# Environment Configuration

## Database (Local Postgres)

All environments run on the self-hosted server (`imajin-server`, 192.168.1.193).

| Environment | Database | User | Port |
|-------------|----------|------|------|
| Production | `imajin_prod` | `imajin` | 5432 |
| Development | `imajin_dev` | `imajin_dev` | 5432 |

Standalone app databases:

| App | Production | Development |
|-----|-----------|-------------|
| fixready | `fixready_prod` | `fixready_dev` |
| karaoke | `karaoke_prod` | `karaoke_dev` |

### Schemas

Each service owns a schema within the shared database:

| Schema | Service(s) |
|--------|-----------|
| `auth` | kernel |
| `profile` | kernel |
| `connections` | kernel |
| `pay` | kernel |
| `chat` | kernel |
| `media` | kernel |
| `notify` | kernel |
| `registry` | kernel |
| `events` | events |
| `coffee` | coffee |
| `learn` | learn |
| `market` | market |

Connection string format:
```
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/DATABASE"
```

Postgres is open to LAN (192.168.1.0/24). `pg_stat_statements` enabled for query performance tracking.

## Services

All services run via **pm2** on the server. **Caddy** handles reverse proxy with auto-SSL.

### Port Convention

- `3xxx` = development, `7xxx` = production (1:1 mapping)
- `x000-x099` — **Core platform** (kernel, events)
- `x100-x199` — **Imajin apps** (coffee, dykil, links, learn — account-based, DID-linked)
- `x400-x499` — **Client apps** (fixready, karaoke — standalone repos, own databases)
- Internal daemons (e.g. corpus) are not subdomain-routed and don't follow this
  convention — see their own row for the (different) fixed ports they use.
  dev and prod still can't share a port, since dev-* and prod-* pm2
  processes run side by side on the same host.

| Tier | Service | Dev | Prod | Domain |
|------|---------|-----|------|--------|
| Core | kernel | 3000 | 7000 | imajin.ai (+ auth/pay/profile/connections/registry/chat/media/notify subdomains via Caddy) |
| Core | events | 3006 | 7006 | jin.imajin.ai/events |
| Imajin | coffee | 3100 | 7100 | jin.imajin.ai/coffee |
| Imajin | dykil | 3101 | 7101 | jin.imajin.ai/dykil |
| Imajin | links (external, [ima-jin/links](https://github.com/ima-jin/links)) | 3102 | 7102 | jin.imajin.ai/links |
| Imajin | learn | 3103 | 7103 | jin.imajin.ai/learn |
| Imajin | market | 3104 | 7104 | jin.imajin.ai/market |
| Client | fixready | 3400 | 7400 | fixready.imajin.ai |
| Client | karaoke | 3401 | 7401 | karaoke.imajin.ai |
| Infra | corpus | 8013 | 8003 | internal only — no subdomain (#1726) |

**corpus host note (#2232, decided 2026-09-22):** corpus's prod port (8003)
above is its own canonical port, but corpus no longer runs on the same host
as the rest of prod — it's deployed on **gx10**, not the ProLiant
(`deploy/ecosystem.prod.config.js` has no `prod-corpus` entry; see that
file's README). Dev corpus (8013) is unaffected and still runs on the
ProLiant alongside `dev-jin`.

**links host note (#1986 phase 2):** links moved out of this monorepo into
its own repo, [ima-jin/links](https://github.com/ima-jin/links) (kernel-side
prune merged 2026-09-28). Its ports (3102/7102) and Caddy route
(`jin.imajin.ai/links`) are unchanged — it is still deployed on this same
host, just as a standalone `dev-links`/`prod-links` pm2 process built from
its own repo checkout instead of `deploy/ecosystem.{dev,prod}.config.js`.

The kernel reaches corpus over HTTP via `CORPUS_SERVICE_URL`
(`apps/kernel/.env.example`) — its `localhost` default is only correct when
kernel and corpus are colocated on the same host; point it at gx10 in prod.

### pm2 Naming

- **Bare names** = production (e.g., `kernel`, `events`)
- **`dev-*` prefix** = development (e.g., `dev-kernel`, `dev-events`)

## Shared Packages

| Package | Purpose |
|---------|---------|
| `@imajin/auth` | Ed25519 signing, verification, DID creation |
| `@imajin/db` | Database layer (postgres-js + drizzle-orm) |
| `@imajin/config` | Shared configuration |
| `@imajin/ui` | Shared UI components (NavBar, Footer, dark theme) |
| `@imajin/input` | Input components (emoji, voice, GPS, file upload) |
| `@imajin/media` | Media browser & asset display components |
| `@imajin/fair` | .fair attribution (types, validator, FairEditor, FairAccordion) |
| `@imajin/onboard` | `<OnboardGate>` — shared anonymous → soft DID onboarding flow |
| `@imajin/email` | Email sending (SendGrid) + templates + QR generation |
| `@imajin/trust-graph` | Trust graph queries (connection checks) |

## Environment Variables

Each service has a `.env.local` file. Common variables:

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | Postgres connection string | `postgresql://imajin_dev:pass@localhost:5432/imajin_dev` |
| `AUTH_SERVICE_URL` | Auth service base URL | `http://localhost:3001` |
| `PAY_SERVICE_URL` | Pay service base URL | `http://localhost:3004` |
| `CONNECTIONS_SERVICE_URL` | Connections service URL | `http://localhost:3003` |
| `PROFILE_SERVICE_URL` | Profile service URL | `http://localhost:3005` |
| `NEXT_PUBLIC_SERVICE_PREFIX` | URL scheme prefix | `https://` (prod) or `http://` (dev) |
| `NEXT_PUBLIC_DOMAIN` | Base domain | `imajin.ai` |
| `NEXT_PUBLIC_BASE_URL` | Service's own base URL | `http://localhost:3006` |
| `APP_URL` | Kernel's public origin for server-side browser redirects (runtime, not build-inlined — origin only) | `https://jin.imajin.ai` |

**⚠️ Service-to-service URLs must come from env vars — never hardcode URLs.**

Every app that uses env vars should have a matching `.env.example` file.

### check-env annotations (#2246)

`scripts/check-env.ts` validates every service's `.env.local` against its
`.env.example` before a build (`scripts/build.sh`'s pre-flight step). By
default every key in `.env.example` is **required** — missing it from
`.env.local` is a hard error. Three comment annotations, placed on the line
directly above a `KEY=value` line, change that:

| Annotation | Missing from `.env.local` | Set in `.env.local` |
|------------|---------------------------|----------------------|
| `# optional` | OK (grouped into one warning per service) | normal |
| `# vault-sourced: <reason>` | OK, silent (fetched at boot instead) | WARN — "deprecated hand-provisioned value present; remove after rotation" |
| `# deprecated: <reason>` | OK, silent | WARN with `<reason>` |
| _(none)_ | **ERROR** | normal |

```
# vault-sourced: fetched at boot via loadFromVault (#2243), do not set locally
CORPUS_DID_PRIVATE_KEY=
```

Every `apps/*/.env.example` documents this table's short form at the top of
the file. See `apps/corpus/.env.example` and `apps/kernel/.env.example` for
the fullest set of examples (rotation-grace-window keys, vault-fetched
service identity, a one-shot re-pin flag).

This is what let corpus's `.env.local` shrink from a full set of
hand-provisioned secrets down to `PORT` + `NODE_ENV` + the one bootstrap
delegation-grant pointer (`CORPUS_VAULT_GRANT_ID`) plus that grant's small
bootstrap identity (`CORPUS_VAULT_BOOTSTRAP_DID` / `_PRIVATE_KEY`) — the real
signing keypair itself is minted in the vault and fetched at boot, never
hand-copied onto the host (#2241/#2243).

### Internal generated secrets (#2245)

A third secret state, alongside hand-set and vault-sourced-fetched-at-boot:
**granted**. `missing → granted (vault, signed, purpose-bound, unread) →
loaded (fetched in-memory + one deferred ack)`. What ever touches an env
var, CI log, or `.env.example` is the grant reference (or nothing at all)
— never the secret value itself.

This applies to secrets with a **single in-process consumer** (never
fanned out to another service) — e.g. the foreign-principal-stub pepper
(`kernel.foreign-principal-pepper`, replacing the old
`FOREIGN_PRINCIPAL_STUB_SECRET` env var). The ruling (Ryan, 2026-09-22, via
#2245):

> Internal generated secrets don't need a human to *exist* — they need a
> human to *replace or destroy* them. On first boot, the kernel looks up a
> static-secret grant for the purpose, self-granted to its own node DID;
> if none exists, it generates one in-process, seals + self-grants it, and
> emits exactly one mechanical `vault.secret.generated` attestation
> binding the purpose/grantId/content hash — never the bytes. Human
> countersign (canvas card, #2084 roles) is reserved for import / rotate /
> revoke, never for this self-provisioning path.

This is distinct from the `# vault-sourced:` annotation above, which
describes a secret fetched at boot from a grant something else (an
operator, another service) already created. A self-provisioned internal
secret has no annotation at all in `.env.example` — the var is deleted
entirely, since check-env has nothing to validate once no human ever sets
it. See `apps/kernel/src/lib/vault/internal-secret.ts` for the
implementation (generate-vs-fetch decision, the provisioning-claim race
between two boots, and the rotation seam a future rotate card can build on
without changing the "current grant" lookup).

### Shared (cross-service) internal secrets (#2245, second target)

The self-provisioning story above is for a secret with a **single**
in-process consumer. `ATTESTATION_INTERNAL_API_KEY` (used by corpus to
forward ingestion attestations to the kernel's `POST
/api/attestations/internal`, checked by
`apps/kernel/src/lib/auth/require-internal-api-key.ts`) has **two**:
the kernel itself (verifier) and corpus (external caller). The ruling's own
words draw the line exactly here:

> a shared, cross-service secret needs a human to countersign
> import/rotate/revoke, but an internal secret with a single in-process
> consumer... doesn't need a human to *exist* — only to be replaced or
> destroyed.

So existence is still fully automatic (the kernel self-provisions the value
exactly like any other internal secret, via `getInternalSecret`), but
granting the SAME secret to the second party is a deliberate, operator-run
step — `apps/kernel/src/lib/vault/shared-internal-secret.ts`'s
`grantInternalSecretTo`, invoked via
`scripts/grant-attestation-internal-api-key.ts <corpusBootstrapDid>`, once
per corpus deployment. It reuses the field's EXISTING wrapped key material
(no re-seal, see that module's docblock) rather than generating a second
value, so the kernel and corpus always hold the exact same bytes.

Corpus fetches it at boot the same way it already fetches its own signing
keypair (#2243's `loadFromVault`), reusing its EXISTING
`CORPUS_VAULT_BOOTSTRAP_DID`/`_PRIVATE_KEY` identity — no new bootstrap
identity, no new env var. Unlike a fixed `CORPUS_VAULT_GRANT_ID`, this
secret's grant id is not known ahead of time and CHANGES on rotation, so
corpus discovers the CURRENT active grant for the purpose dynamically at
every boot instead (`loadFromVault`'s `resolveGrantByPurpose`,
`packages/auth/src/vault-client.ts`). Rotation is therefore revoke + mint +
re-grant, with no file edit on either side — both processes just pick up
the new value on their next boot.

`ATTESTATION_INTERNAL_API_KEY` carries NO `.env.example` line on either
side anymore (kernel or corpus) — same "deleted entirely" posture as a
single-consumer internal secret. Both `require-internal-api-key.ts` and
`attestation-key.ts` still accept a hand-set env var as a DEPRECATED
fallback (logged once) for any deployment, or any OTHER not-yet-migrated
service via `packages/auth/src/internal-post.ts`, that has not moved onto
the vault path yet — generalizing this pattern to those other callers is
out of scope for #2245.

### Rotate vs. revoke an internal secret (#2354, #2446, #2582)

Two operator actions, one per intent. Both are code-level today
(`apps/kernel/src/lib/vault/`); neither needs a file edit or a hand-set env var.

| | Rotate | Revoke |
|---|---|---|
| Function | `rotateAndStore(field, value)` → `rotateInternalSecret` (`internal-secret-rotate.ts`); the /admin/vault Rotate action | `revokeInternalSecret(purpose)` (`internal-secret-revoke.ts`) |
| Intent | Replace the value and keep everyone working | Withdraw the secret outright |
| Self-grant | Replaced, purpose kept | Revoked, key material erased |
| `internal_secret_provisions` row | Kept, repointed at the new grant | Deleted, in the same transaction |
| External grantees (e.g. corpus) | Re-issued on the new key, terms carried forward | Untouched — revoke an external grantee on its own with `revokeStaticSecretGrant` |
| Next `getInternalSecret(purpose)` | Resolves the rotated value, no restart | Re-provisions a NEW generated value (as on first boot) |

**Rotate** when you want a new value (suspected leak, scheduled rotation) and
the consumers must keep working: the operator supplies the value, the kernel
re-issues each external grantee on the new key.

**Revoke** when the secret should stop being usable under its current value
and you accept a fresh one taking its place — e.g. decommissioning, or
recovering from a compromise where you do not want to choose the replacement.
The self-grant revoke and the provisions-row delete commit together, so a
revoke can never strand the row and break `getInternalSecret` on next boot
(#2354). Every external grantee still holds the OLD wrapped key and no longer
matches the kernel's new value: the re-provision logs an ERROR naming them, and
an operator must re-grant (`grantInternalSecretTo`) or revoke each. On Tier 1
revoke is refused before anything is written (as rotate is), because the node
cannot self-grant to re-provision. Only the calling process's cached value is
dropped; other running processes keep theirs until restart.

### Service bootstrap identities (#2353, #2442)

Each userspace service that fetches `ATTESTATION_INTERNAL_API_KEY` from the
vault at boot authenticates with its own bootstrap identity:
`<SVC>_VAULT_BOOTSTRAP_DID` / `_PRIVATE_KEY` in `apps/<svc>/.env.local`
(today: learn, events, dykil, market, coffee). The pair stays **required**
(no `check-env` annotation) — but nobody mints it by hand any more.
`scripts/provision-service-bootstrap.mjs` does, and the deploy runs it:

- **Where:** `deploy-prod.yml` and `deploy-dev.yml` run
  `node --env-file=apps/kernel/.env.local scripts/provision-service-bootstrap.mjs --all --env <env>`
  after dependencies are installed and **before check-env** (which
  `build-changed.sh` → `build.sh` runs first). In prod the whole job sits behind
  the `production` environment approval, so the gate tap is the human
  countersign from #2245 for these grants. A provisioning failure fails the
  deploy before any restart.
- **Env:** the kernel's own — `DATABASE_URL` and `AUTH_PRIVATE_KEY` from
  `apps/kernel/.env.local` (loaded with `--env-file`, exactly how pm2 starts
  `prod-jin`), and `VAULT_PATH` from the env's `deploy/ecosystem.*.config.js`
  (`--env`), so the grant lands in the same vault file the kernel reads.
- **Discovery:** services are found by scanning `apps/*/.env.example` for
  `<SVC>_VAULT_BOOTSTRAP_DID` — add the two keys to a new service's
  `.env.example` and the next deploy provisions it. A pair annotated
  `# optional` there (corpus) is skipped, and so is a service with no
  `apps/<svc>/.env.local` on that host (creating one would turn `check-env`'s
  warning into an error for a service that isn't deployed there).
- **Per service:** both keys present and non-empty → left alone, never rotated
  or overwritten. Exactly one present, or either empty → the run fails with a
  clear error and changes nothing (fix the file by hand). Both absent → mint an
  Ed25519 keypair + `did:imajin:*` DID (`@imajin/auth`), register it as a kernel
  identity (the vault fetch authenticates against `auth.identities`), and
  append the pair to `.env.local` atomically (temp file + rename, mode 0600).
- **Grant:** for **every** service whose pair exists — minted now or not — the
  `kernel.attestation-internal-api-key` grant is ensured through the same code
  path as `scripts/grant-attestation-internal-api-key.ts`. It is idempotent, so
  a crash between the write and the grant self-heals on the next run.
- **Output:** one line per service, `service · did · minted|existing · grantId`
  (also in the run's step summary). A private key is never printed or logged.

Local dev: `scripts/setup-local.sh` runs the same script with `--all` after
migrations. To provision (or re-check) by hand:
`node --env-file=apps/kernel/.env.local scripts/provision-service-bootstrap.mjs --all`
(or pass a single `<service>`, e.g. `market`).

The entrypoint runs as ESM under plain `node` (#2483), like `scripts/migrate.mjs`:
run through `tsx` the kernel's TypeScript compiles to CommonJS, which cannot load
ESM-only dependencies such as `@ipld/dag-cbor`. `--dry-run` validates every
`.env.local` pair and loads every module a real run imports, without minting,
writing, granting or contacting the database; CI's "Provisioning entrypoint" job
runs the deploy command plus `--dry-run` against a production-style install.

### Per-env deploy targets (#2246)

A service with no `.env.local` at all is only a **hard error** when it's
actually part of that environment's pm2 deploy target; otherwise it's a
warning. "Deploy target" is read straight from `deploy/ecosystem.{dev,prod}.config.js`'s
`cwd` entries (the same file `build.sh`'s ecosystem-sync step and the deploy
workflows already treat as canonical) — not a separate manifest. This is why
corpus's missing `.env.local` is an error in dev (it's in
`ecosystem.dev.config.js`) but only a warning in prod (removed from
`ecosystem.prod.config.js`; see the corpus host note above and
`deploy/README.md`).

### VAULT_PATH — per-env vault file split (#2357)

`VAULT_PATH` is the absolute path to the kernel's on-disk sealed-secrets
vault file (`FileVaultRepository` — owner GitHub OAuth tokens, connector
config, Warp API keys sealed via `seal_key`, etc). It is **not** a key in
`apps/kernel/.env.example` and must not be set in `apps/kernel/.env.local`
(#2487): the pm2 ecosystem config is its single source of truth. `check-env`
reports a stray `VAULT_PATH` in `.env.local` as an extra key, and the
pre-deploy check below fails the deploy when it disagrees with the ecosystem.

| Environment | pm2 process | `VAULT_PATH` |
|-------------|--------------|--------------|
| Development | `dev-jin` | `~/.imajin/vault.dev.json` |
| Production | `prod-jin` | `~/.imajin/vault.prod.json` |

Both values are set directly in `deploy/ecosystem.{dev,prod}.config.js`'s
`env` block (not `.env.local`), mirroring how `NODE_ENV` is already pinned
there. pm2 env beats the kernel's `--env-file`, so a restart from the
ecosystem file alone always resolves the same vault file. A literal leading `~` is expanded to the process's home directory at
runtime (`apps/kernel/src/lib/vault/vault-path.ts`) — pm2 ecosystem configs
are version-controlled and can't embed a concrete home directory. The kernel
refuses to start in production when `VAULT_PATH` is unset (see
`instrumentation.ts#register()`), rather than silently falling back to the
shared `~/.imajin/vault.json` default used outside production.

#### One source of truth, checked before every deploy (#2487)

The deploy's provisioning step (#2442) runs as
`node --env-file=apps/kernel/.env.local scripts/provision-service-bootstrap.mjs`,
and `--env-file` values beat the ecosystem fallback. A `VAULT_PATH` in
`.env.local` therefore made the provisioner write into one vault file while the
running kernel (pm2 env) read another, and the provisioner refused to continue
on the empty one. `deploy-prod.yml` / `deploy-dev.yml` now run
`scripts/check-vault-path-consistency.mjs` first. It fails the deploy, naming
both paths, when any of these disagree:

- the ecosystem config's `VAULT_PATH` for the kernel app (`prod-jin`/`dev-jin`),
- `VAULT_PATH` in `apps/kernel/.env.local` or the deploy shell (what the
  provisioner would use),
- `VAULT_PATH` in the **running** kernel's pm2 env (read from `pm2 jlist`;
  skipped when the kernel is not running, e.g. a first deploy).

A `.env.local` value that merely matches the ecosystem is a warning. The check
prints paths and verdicts only (also to the step summary): it never opens the
vault and reads nothing from `pm2 jlist` but `VAULT_PATH`.

#### Fail-loud vault file (#2412)

A configured `VAULT_PATH` must point at a file that exists. v0.8.8 shipped
`VAULT_PATH=~/.imajin/vault.prod.json` while only `vault.json` existed on the
box; the vault silently loaded as empty and every sealed secret resolved to
`undefined` for ~9h while `/api/health` was green. Now:

- **Boot** (`instrumentation.ts#register()`): the kernel loads the vault and
  logs `vault: loaded N entries from <path>`. A missing configured file makes
  boot throw, so pm2 crash-loops loudly instead of serving an empty vault.
- **`/api/health`** has a `vault` block: `status` (`ok` / `empty` / `error`),
  `path`, `entryCount`, `lastLoadedAt`, `bootstrapped`. Never field names or
  values. `error` always degrades the aggregate; `empty` degrades it in
  production (zero sealed entries is a red flag there).
- **`check-env`** (run by `scripts/build.sh` before pm2 restarts) fails when the
  kernel is checked and `VAULT_PATH` (process env, else the env's
  `deploy/ecosystem.*.config.js`) names a missing file.
- **First-run bootstrap is explicit:** set `VAULT_ALLOW_BOOTSTRAP=1` (or `true`)
  in the kernel's env to start a brand-new vault at a path that does not exist
  yet. The kernel then loads an empty store, warns on every boot while the flag
  is set, and creates the file on the first seal. `check-env` downgrades the
  missing file to a warning. Unset the flag once the file exists. With no
  `VAULT_PATH` at all (non-production local dev) the default
  `~/.imajin/vault.json` still bootstraps implicitly, as before.

The split matters because Postgres is already isolated per environment (a
separate `imajin_prod`/`imajin_dev` database and `DATABASE_URL` each), but
until #2357 the vault was not: `dev-jin` and `prod-jin` both defaulted to the
same `~/.imajin/vault.json`, so a dev process could read — and, on any
re-seal, silently overwrite — prod-sealed material. Splitting the file is
the same trust boundary Postgres already draws, applied to the one piece of
per-environment state that was missing it.

## Deployment

See [DEPLOYMENT.md](../DEPLOYMENT.md) for the full deployment pipeline.

## Database Migrations

```bash
# On server — dev (runs all services)
cd ~/dev/imajin-ai
./scripts/migrate.sh

# On server — single service
./scripts/migrate.sh auth

# On server — prod (be careful!)
cd ~/prod/imajin-ai
./scripts/migrate.sh
```

> **⚠️ Never use `drizzle-kit push`.** See DEVELOPER.md for migration discipline rules.

## GPU Node (imajin-ml)

ML/compute services run on a dedicated GPU node (`192.168.1.124`), not the ProLiant.

| Service | Port | Model | Purpose |
|---------|------|-------|---------|
| Whisper | 8765 | large-v3 (CUDA float16) | Speech-to-text transcription |
| Ollama | 11434 | qwen2.5-coder:7b, nomic-embed-text | Code refactoring, embeddings |

The kernel service relays audio to the GPU node over LAN for transcription. No public subdomain for the GPU node — internal only.

- **Repo:** [ima-jin/imajin-ml](https://github.com/ima-jin/imajin-ml)
- **Server path:** `~/imajin-ml`

## Local Development

To develop locally against the server DB, SSH tunnel:
```bash
ssh -f -N -L 5432:127.0.0.1:5432 jin@192.168.1.193
```

Then use `localhost:5432` in your `.env.local`.

## Config Files

| File | Location |
|------|----------|
| Caddy | `/etc/caddy/Caddyfile` |
| pm2 prod | `~/prod/ecosystem.config.js` |
| pm2 dev | `~/dev/ecosystem.config.js` |
| Env files | `.env.local` in each app directory |
