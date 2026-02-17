# Environment Configuration

## Database Branches (Neon)

The platform uses Neon Postgres with branch-based environment isolation.

| Environment | Neon Branch | Endpoint | Purpose |
|-------------|-------------|----------|---------|
| Production | production | ep-small-flower-aiy84lkh-pooler | Live site (imajin.ai) |
| Staging | staging | ep-damp-scene-aik9j5ah | Vercel preview deployments |
| Development | dev | ep-tiny-river-aivlleyx | Local development |

### Connection Strings

```
# Production (Vercel production)
DATABASE_URL="postgresql://neondb_owner:PASSWORD@ep-small-flower-aiy84lkh-pooler.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require"

# Staging (Vercel preview)
DATABASE_URL="postgresql://neondb_owner:PASSWORD@ep-damp-scene-aik9j5ah.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require"

# Development (local)
DATABASE_URL="postgresql://neondb_owner:PASSWORD@ep-tiny-river-aivlleyx.c-4.us-east-1.aws.neon.tech/neondb?sslmode=require"
```

## Vercel Configuration

### Environment Variables

Set these in Vercel project settings:

**Production** (imajin.ai):
- `DATABASE_URL`: Production connection string

**Preview** (PR deployments):
- `DATABASE_URL`: Staging connection string

### Deployment Triggers

- **Production**: Push to `main` branch
- **Preview**: Pull request opened/updated

## Local Development

1. Copy `.env.example` to `.env.local`
2. Use the dev branch connection string
3. Run `pnpm dev`

```bash
# Apps run on different ports:
# www:      http://localhost:3000
# auth:     http://localhost:3003
# pay:      http://localhost:3004
# profile:  http://localhost:3005
# registry: http://localhost:3006
```

## Database Migrations

Run migrations against the appropriate branch:

```bash
# Development
cd apps/www && pnpm db:push

# Staging (set DATABASE_URL first)
DATABASE_URL="staging-url" pnpm db:push

# Production (be careful!)
DATABASE_URL="production-url" pnpm db:push
```

### Branch Workflow

1. Create feature branch in git
2. Work locally against `dev` Neon branch
3. Open PR → Vercel deploys to preview with `staging` DB
4. Merge to main → Vercel deploys to production with `production` DB

### Resetting Branches

To reset staging to match production:

```bash
neonctl branches delete staging --project-id polished-meadow-93896384
neonctl branches create --name staging --parent production --project-id polished-meadow-93896384
```

## Neon CLI Commands

```bash
# List branches
neonctl branches list --project-id polished-meadow-93896384

# Create branch
neonctl branches create --name BRANCH_NAME --parent production --project-id polished-meadow-93896384

# Delete branch
neonctl branches delete BRANCH_NAME --project-id polished-meadow-93896384

# Get connection string
neonctl connection-string BRANCH_NAME --project-id polished-meadow-93896384
```
