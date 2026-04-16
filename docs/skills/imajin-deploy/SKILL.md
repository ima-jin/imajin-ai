---
name: imajin-deploy
description: "Deploy, build, and manage Imajin services on the HP ProLiant server. Use when: deploying to dev or prod, restarting services, checking pm2 status, running migrations, debugging deploy failures, pulling and rebuilding. NOT for: editing code on the server (never do this), deploying without Ryan's explicit request. Triggers on: deploy, restart, rebuild, pm2, server, prod, migration, build-changed."
metadata:
  openclaw:
    emoji: "🚀"
---

# Imajin Deploy Skill

## ⛔ CRITICAL RULES

1. **NEVER deploy to dev or prod unless Ryan explicitly asks.** Ryan handles the majority of deploys from permanent SSH sessions on the server. If he says stop, STOP.
2. **NEVER edit code on the server.** Changes go through workspace → commit → push → pull on server.
3. **NEVER set NODE_ENV in the shell.** Build scripts handle it internally. Setting it breaks pnpm installs.
4. **After pulling main, rebuild EVERYTHING that changed.** Stale `.next` builds are the #1 time waster.

## Server Details

- **Host:** imajin-server (192.168.1.193)
- **User:** jin (SSH key auth)
- **SSH:** `ssh jin@192.168.1.193`
- **PATH prefix:** `export PATH=/home/jin/.nvm/versions/node/v22.22.0/bin:$PATH`

## Directory Layout

| Path | Purpose |
|------|---------|
| `~/dev/imajin-ai/` | Dev monorepo |
| `~/prod/imajin-ai/` | Prod monorepo |
| `~/dev/imajin-fixready/` | Dev fixready (separate repo) |
| `~/prod/imajin-fixready/` | Prod fixready (separate repo) |
| `~/dev/imajin-karaoke/` | Dev karaoke (separate repo) |
| `~/prod/imajin-karaoke/` | Prod karaoke (separate repo) |
| `~/dev/ecosystem.config.js` | Dev pm2 config |
| `~/prod/ecosystem.config.js` | Prod pm2 config |

## pm2 Process Names

**Convention:** `{env}-{app}` except kernel which is `{env}-jin`.

| App | Dev Process | Prod Process | Dev Port | Prod Port |
|-----|-------------|--------------|----------|-----------|
| kernel | dev-jin | prod-jin | 3000 | 7000 |
| events | dev-events | prod-events | 3006 | 7006 |
| coffee | dev-coffee | prod-coffee | 3100 | 7100 |
| dykil | dev-dykil | prod-dykil | 3101 | 7101 |
| links | dev-links | prod-links | 3102 | 7102 |
| learn | dev-learn | prod-learn | 3103 | 7103 |
| market | dev-market | prod-market | 3104 | 7104 |
| fixready | dev-fixready | prod-fixready | 3400 | 7400 |
| karaoke | dev-karaoke | prod-karaoke | 3401 | 7401 |

**Note:** Prod ecosystem.config.js lists individual services (www, auth, registry, etc.) but in practice they all run as one kernel process (prod-jin) on port 7000. The ecosystem file is outdated for kernel services — prod-jin was started ad-hoc with `server.js -p 7000`.

## Standard Deploy Procedure

Ryan's typical workflow (from a permanent SSH session on the server):

```bash
# 1. Pull latest
cd ~/dev/imajin-ai  # or ~/prod/imajin-ai
git pull origin main

# 2. Build changed apps (auto-detects what changed via git diff)
./scripts/build-changed.sh

# 3. That's it — build-changed.sh handles:
#    - Detecting changed apps via pnpm dependency graph
#    - Pre-flight env var check (check-env.ts)
#    - Running migrations (migrate-service.mjs per app)
#    - Building each changed app (next build)
#    - Restarting pm2 processes for successful builds
```

## Build Scripts

### `scripts/build-changed.sh`
- Detects changed apps since last build (stored in `.last-build-sha`)
- Uses pnpm filter to catch transitive changes (e.g., packages/db change → all apps that import it)
- Delegates to `build.sh` with the app list
- Auto-detects dev/prod from working directory (`~/prod/` vs `~/dev/`)
- First run (no `.last-build-sha`): builds all apps

### `scripts/build.sh [app1 app2 ...]`
Pipeline per app:
1. **Pre-flight:** `check-env.ts` validates `.env.local` against `.env.example`
2. **Migrate:** `migrate-service.mjs` runs drizzle migrations per service (per-service tracking table: `__drizzle_migrations_{app}`)
3. **Build:** `next build` (with `rm -rf .next` first)
4. **Restart:** `pm2 restart {env}-{app}` (only for successful builds)

Writes a build report to `.build-report`.

### `scripts/migrate-service.mjs <app>`
- Reads `DATABASE_URL` from app's `.env.local`
- Runs drizzle migrate against `apps/{app}/drizzle/` folder
- Uses per-service tracking table (`__drizzle_migrations_{app}` in `drizzle` schema)
- **Known issues:** hash mismatches, phantom rows, cross-service ordering (#684 will replace this)

## Migration Pain Points (Current — Pre-#684)

Drizzle migrations fail frequently. Common scenarios:

1. **Dev has manual DB changes not in migration files.** Many schema changes on dev were applied via raw SQL and never got proper migration files.
2. **Hash mismatch.** If a migration file is edited after running anywhere, drizzle rejects it. Fix: manually delete the tracking row in `drizzle.__drizzle_migrations_{app}`.
3. **Cross-service ordering.** Kernel references profile tables but migrates first (alphabetical). Profile must migrate before kernel.
4. **Phantom rows.** Partial failures record migration as applied when DDL didn't execute. Requires manual DB surgery.
5. **All DDL should be idempotent.** `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`. This lets you re-run safely.

**Upcoming fix:** #684 replaces drizzle migrator with single-folder plain SQL runner. Sequential numbering, cross-service ordering solved by file order, idempotent DDL, ~50 line runner.

## When Migrations Fail (Manual Recovery)

```bash
# SSH to server
ssh jin@192.168.1.193

# Check what failed
cat ~/dev/imajin-ai/.build-report  # or ~/prod/...

# Connect to DB
psql -U imajin_dev -d imajin_dev    # dev
psql -U imajin -d imajin_prod       # prod

# Check migration tracking
SELECT * FROM drizzle.__drizzle_migrations_kernel ORDER BY created_at DESC LIMIT 10;

# Delete a phantom/bad tracking row
DELETE FROM drizzle.__drizzle_migrations_kernel WHERE id = <id>;

# Run the DDL manually
\i apps/kernel/drizzle/0023_dfos_relay_081.sql

# Then retry
./scripts/build.sh kernel
```

## Caddy (Reverse Proxy)

Config: `/etc/caddy/Caddyfile`

**Routing pattern:** Single domain per environment. Kernel handles `/` and all kernel routes. Userspace apps get path-prefixed routes (`/events/*`, `/market/*`, etc.) proxied to their ports. Each userspace app has `basePath` set in `next.config.js` matching the prefix.

| Domain | Environment |
|--------|-------------|
| `jin.imajin.ai` | Production |
| `dev-jin.imajin.ai` | Development |

Static media files served directly by Caddy from `/mnt/media` (not through Next.js).

```bash
# Reload caddy after config changes
sudo systemctl reload caddy

# Check caddy logs
sudo journalctl -u caddy -f
```

## CI Pipeline

- **Push to main** → GitHub Actions (self-hosted runner, label: `imajin`) → auto-deploy to dev
- **Push `v*` tag** → deploy to prod (monorepo only)
- **`[skip ci]`** in commit message → skip pipeline entirely (useful for iteration)

CI checks: Build, Lint, Security Audit, SonarCloud, Check Migrations (sql count = snapshot count).

## Quick Reference Commands

```bash
# Check what's running
ssh jin@192.168.1.193 'export PATH=/home/jin/.nvm/versions/node/v22.22.0/bin:$PATH && pm2 list'

# View logs for a service
ssh jin@192.168.1.193 'export PATH=/home/jin/.nvm/versions/node/v22.22.0/bin:$PATH && pm2 logs prod-jin --lines 50'

# Restart a single service
ssh jin@192.168.1.193 'export PATH=/home/jin/.nvm/versions/node/v22.22.0/bin:$PATH && pm2 restart prod-events'

# Check build report
ssh jin@192.168.1.193 'cat ~/prod/imajin-ai/.build-report'

# Check env vars for an app
ssh jin@192.168.1.193 'export PATH=/home/jin/.nvm/versions/node/v22.22.0/bin:$PATH && cd ~/prod/imajin-ai && npx tsx scripts/check-env.ts --env prod kernel events'

# Imajin status script
ssh jin@192.168.1.193 '~/bin/imajin-status'
```

## Databases

| Database | User | Environment |
|----------|------|-------------|
| imajin_dev | imajin_dev | Dev |
| imajin_prod | imajin | Prod |
| fixready_dev | imajin_dev | Dev |
| fixready_prod | imajin | Prod |
| karaoke_dev | imajin_dev | Dev |
| karaoke_prod | imajin | Prod |

Postgres on `192.168.1.193:5432`, open to LAN (192.168.1.0/24).
