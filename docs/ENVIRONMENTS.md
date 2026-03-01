# Environment Configuration

## Database (Local Postgres)

All environments run on the self-hosted server (`imajin-server`, 192.168.1.193).

| Environment | Database | User | Port |
|-------------|----------|------|------|
| Production | `imajin_prod` | `imajin` | 5432 |
| Development | `imajin_dev` | `imajin_dev` | 5432 |

Connection string format:
```
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/DATABASE"
```

Postgres is open to LAN (192.168.1.0/24). `pg_stat_statements` enabled for query performance tracking.

## Services

All services run via **pm2** on the server. **Caddy** handles reverse proxy with auto-SSL.

### Port Convention

- `3xxx` = development
- `7xxx` = production
- `x000-x099` = core platform services
- `x400+` = client applications

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
