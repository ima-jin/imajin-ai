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
