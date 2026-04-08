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

| Tier | Service | Dev | Prod | Domain |
|------|---------|-----|------|--------|
| Core | kernel | 3000 | 7000 | imajin.ai (+ auth/pay/profile/connections/registry/chat/media/notify subdomains via Caddy) |
| Core | events | 3006 | 7006 | events.imajin.ai |
| Imajin | coffee | 3100 | 7100 | coffee.imajin.ai |
| Imajin | dykil | 3101 | 7101 | dykil.imajin.ai |
| Imajin | links | 3102 | 7102 | links.imajin.ai |
| Imajin | learn | 3103 | 7103 | learn.imajin.ai |
| Imajin | market | 3104 | 7104 | market.imajin.ai |
| Client | fixready | 3400 | 7400 | fixready.imajin.ai |
| Client | karaoke | 3401 | 7401 | karaoke.imajin.ai |

### pm2 Naming

- **Bare names** = production (e.g., `kernel`, `events`)
- **`dev-*` prefix** = development (e.g., `dev-kernel`, `dev-events`)

## Shared Packages

| Package | Purpose |
|---------|---------|
| `@imajin/auth` | Ed25519 signing, verification, DID creation |
| `@imajin/db` | Database layer (postgres-js + drizzle-orm) |
| `@imajin/pay` | Unified payments (Stripe + Solana) |
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

**⚠️ Service-to-service URLs must come from env vars — never hardcode URLs.**

Every app that uses env vars should have a matching `.env.example` file.

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
