# Deployment Guide

## Infrastructure

| Component | Details |
|-----------|---------|
| Server | HP ProLiant ML350p Gen8, Ubuntu 24.04 LTS |
| IP | 192.168.1.193 |
| User | jin (SSH key auth) |
| Process manager | pm2 |
| Reverse proxy | Caddy (auto-SSL) |
| CI runner | GitHub Actions self-hosted (org-level, label: `imajin`) |
| GPU node | 192.168.1.124 (RTX 3080 Ti — Whisper, Ollama) |

## Environments

| Environment | Repo path | Database | pm2 prefix |
|-------------|-----------|----------|------------|
| Production | `~/prod/imajin-ai` | `imajin_prod` | bare (`www`, `auth`) |
| Development | `~/dev/imajin-ai` | `imajin_dev` | `dev-` (`dev-www`, `dev-auth`) |

## CI/CD Pipeline

### Automatic (standard)

```
Push to main → GitHub Actions → build → deploy to dev
Push v* tag  → GitHub Actions → build → deploy to prod
```

The pipeline:
1. Runner pulls latest to `~/dev/imajin-ai` (or `~/prod/imajin-ai`)
2. `pnpm install && pnpm build`
3. `drizzle-kit push` for schema changes
4. `pm2 restart` affected services

### Iteration Workflow (skip CI)

For active development when iterating quickly:

```bash
# 1. Commit with [skip ci]
git commit -m "fix: whatever [skip ci]"
git push

# 2. Manually pull and rebuild on server
ssh jin@192.168.1.193 'export PATH=/home/jin/.nvm/versions/node/v22.22.0/bin:$PATH && \
  cd ~/dev/imajin-ai && git pull origin main && \
  pnpm --filter @imajin/SERVICE-NAME build && \
  pm2 restart dev-SERVICE'
```

### Branch Workflow (clean history)

For feature work where commit history matters:

1. Create a branch, iterate freely
2. Squash merge to main with one clean commit
3. CI + deploy runs automatically

## Adding a New Service

### 1. Port Assignment

Follow the port convention (see [ENVIRONMENTS.md](./docs/ENVIRONMENTS.md)):
- `x000-x099` — Core platform services
- `x100-x199` — Imajin apps (account-based, DID-linked)
- `x400-x499` — Client apps (standalone repos)

Dev ports are `3xxx`, prod ports are `7xxx` (1:1 mapping).

### 2. pm2 Configuration

Add to `~/dev/ecosystem.config.js` (and `~/prod/ecosystem.config.js`):

```javascript
{
  name: 'dev-myservice',      // or just 'myservice' for prod
  cwd: './imajin-ai/apps/myservice',
  script: 'npm',
  args: 'start',
  env: {
    PORT: 3xxx,               // dev port
    NODE_ENV: 'production',
  },
}
```

### 3. Caddy Configuration

Add to `/etc/caddy/Caddyfile`:

```
dev-myservice.imajin.ai {
    reverse_proxy localhost:3xxx
}

myservice.imajin.ai {
    reverse_proxy localhost:7xxx
}
```

Then reload: `sudo systemctl reload caddy`

### 4. Database Schema

If the service needs its own schema:

```bash
cd ~/dev/imajin-ai/apps/myservice
DATABASE_URL=$(grep DATABASE_URL .env.local | cut -d'"' -f2) npx drizzle-kit push --force
```

### 5. DNS

Add A records for `dev-myservice.imajin.ai` and `myservice.imajin.ai` pointing to the server (or use wildcard if configured).

## Important Notes

- **Dev services run `npm start` (production builds)**, not `npm run dev`. Source edits require `npx next build` + `pm2 restart` to take effect.
- **`rm -rf .next`** is needed when shared package changes (like `@imajin/ui`) aren't picked up by incremental builds.
- **Service-to-service URLs** come from `.env.local` env vars (`AUTH_SERVICE_URL`, `PAY_SERVICE_URL`, etc.) — never hardcode URLs.
- **Never edit code on the server.** Edit locally → push → pipeline deploys.

## Standalone Repos

These services are in separate repos and have their own deployment:

| Repo | Server path (dev) | Server path (prod) |
|------|-------------------|-------------------|
| [imajin-fixready](https://github.com/ima-jin/imajin-fixready) | `~/dev/imajin-fixready` | `~/prod/imajin-fixready` |
| [imajin-karaoke](https://github.com/ima-jin/imajin-karaoke) | `~/dev/imajin-karaoke` | `~/prod/imajin-karaoke` |

## Config Files

| File | Location |
|------|----------|
| Caddy | `/etc/caddy/Caddyfile` |
| pm2 prod | `~/prod/ecosystem.config.js` |
| pm2 dev | `~/dev/ecosystem.config.js` |
| Env files | `.env.local` in each app directory |
