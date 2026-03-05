# Environment Configuration

## Database (Local Postgres)

All environments run on the self-hosted server (`imajin-server`, 192.168.1.193).

| Environment | Database | User | Port |
|-------------|----------|------|------|
| Production | `imajin_prod` | `imajin` | 5432 |
| Development | `imajin_dev` | `imajin_dev` | 5432 |

Database schemas: `auth`, `profile`, `events`, `coffee`, `chat`, `connections`, `input`, `media` (one schema per service, shared database).

Connection string format:
```
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/DATABASE"
```

Postgres is open to LAN (192.168.1.0/24). `pg_stat_statements` enabled for query performance tracking.

## Services

All services run via **pm2** on the server. **Caddy** handles reverse proxy with auto-SSL.

### Port Convention

- `3xxx` = development, `7xxx` = production (1:1 mapping)
- `x000-x099` — **Core platform** (www, auth, pay, events, input, media, etc.)
- `x100-x199` — **Imajin apps** (coffee, dykil, links, learn — account-based, DID-linked)
- `x400-x499` — **Client apps** (fixready, karaoke — standalone repos, own databases)

| Tier | Service | Dev | Prod |
|------|---------|-----|------|
| Core | www | 3000 | 7000 |
| Core | auth | 3001 | 7001 |
| Core | registry | 3002 | 7002 |
| Core | connections | 3003 | 7003 |
| Core | pay | 3004 | 7004 |
| Core | profile | 3005 | 7005 |
| Core | events | 3006 | 7006 |
| Core | chat | 3007 | 7007 |
| Core | input | 3008 | 7008 |
| Core | media | 3009 | 7009 |
| Imajin | coffee | 3100 | 7100 |
| Imajin | dykil | 3101 | 7101 |
| Imajin | links | 3102 | 7102 |
| Imajin | learn | 3103 | 7103 |
| Client | fixready | 3400 | 7400 |
| Client | karaoke | 3401 | 7401 |

### pm2 Naming

- **Bare names** = production (e.g., `www`, `auth`, `events`)
- **`dev-*` prefix** = development (e.g., `dev-www`, `dev-auth`, `dev-events`)

## Deployment

- **GitHub Actions self-hosted runner** on imajin-server (org-level, label: `imajin`)
- Push to `main` → CI → auto-deploy to **dev**
- Push `v*` tag → deploy to **prod**

### Deploy Pipeline

1. Runner pulls latest to `~/dev/imajin-ai` (or `~/prod/imajin-ai`)
2. `pnpm install && pnpm build`
3. `drizzle-kit push` for schema changes
4. `pm2 restart` affected services

## Database Migrations

```bash
# On server — dev
cd ~/dev/imajin-ai/apps/SERVICE
DATABASE_URL=$(grep DATABASE_URL .env.local | cut -d'"' -f2) npx drizzle-kit push --force

# On server — prod (be careful!)
cd ~/prod/imajin-ai/apps/SERVICE
DATABASE_URL=$(grep DATABASE_URL .env.local | cut -d'"' -f2) npx drizzle-kit push --force
```

## GPU Node (imajin-ml)

ML/compute services run on a dedicated GPU node (`192.168.1.124`), not the ProLiant.

| Service | Port | Model | Purpose |
|---------|------|-------|---------|
| Whisper | 8765 | large-v3 (CUDA float16) | Speech-to-text transcription |

The input service relays audio to the GPU node over LAN. No public subdomain — internal only.

- **Repo:** [ima-jin/imajin-ml](https://github.com/ima-jin/imajin-ml)
- **Server path:** `~/imajin-ml`
- **Process:** uvicorn (systemd planned)

## Local Development

To develop locally against the server DB, SSH tunnel:
```bash
ssh -f -N -L 5432:127.0.0.1:5432 jin@192.168.1.193
```

Then use `localhost:5432` in your `.env.local`.

## Config

- **Caddy:** `/etc/caddy/Caddyfile`
- **pm2 prod:** `~/prod/ecosystem.config.js`
- **pm2 dev:** `~/dev/ecosystem.config.js`
- **Env files:** `.env.local` in each app directory

