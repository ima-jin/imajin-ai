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
| Imajin | links | 3102 | 7102 | jin.imajin.ai/links |
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
config, Warp API keys sealed via `seal_key`, etc). It carries NO annotation
in `apps/kernel/.env.example`, so `check-env` treats a missing value as a
hard error for both the dev and prod kernel targets — the same posture as
`DATABASE_URL`.

| Environment | pm2 process | `VAULT_PATH` |
|-------------|--------------|--------------|
| Development | `dev-jin` | `~/.imajin/vault.dev.json` |
| Production | `prod-jin` | `~/.imajin/vault.prod.json` |

Both values are set directly in `deploy/ecosystem.{dev,prod}.config.js`'s
`env` block (not `.env.local`), mirroring how `NODE_ENV` is already pinned
there. A literal leading `~` is expanded to the process's home directory at
runtime (`apps/kernel/src/lib/vault/vault-path.ts`) — pm2 ecosystem configs
are version-controlled and can't embed a concrete home directory. The kernel
refuses to start in production when `VAULT_PATH` is unset (see
`instrumentation.ts#register()`), rather than silently falling back to the
shared `~/.imajin/vault.json` default used outside production.

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
