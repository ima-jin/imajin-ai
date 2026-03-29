# Developer Guide

Getting started with the imajin-ai monorepo.

## Prerequisites

- **Node.js 22+** (use [nvm](https://github.com/nvm-sh/nvm))
- **pnpm** (`npm install -g pnpm`)
- **PostgreSQL** (local install or SSH tunnel to server)

## Quickstart (Local Dev from Zero)

```bash
# 1. Clone and install
git clone https://github.com/ima-jin/imajin-ai.git
cd imajin-ai
pnpm install

# 2. Create a local database
createdb imajin_dev

# 3. Set up env files — copy from examples
for app in auth profile registry connections pay events chat media coffee dykil links learn market; do
  cp apps/$app/.env.example apps/$app/.env.local 2>/dev/null
done

# 4. Edit DATABASE_URL in each .env.local to point to your local Postgres
#    e.g. DATABASE_URL="postgresql://your_user:your_pass@localhost:5432/imajin_dev"

# 5. Generate an Ed25519 private key for auth (PKCS#8 format, used to sign JWTs)
node -e "const kp = require('crypto').generateKeyPairSync('ed25519'); console.log(kp.privateKey.export({type:'pkcs8',format:'der'}).toString('hex'))"
#    Put the output (96 hex chars) in apps/auth/.env.local as AUTH_PRIVATE_KEY=<hex>

# 6. Disable invite gate for local dev (in apps/auth/.env.local)
#    NEXT_PUBLIC_DISABLE_INVITE_GATE=true

# 7. Run all database migrations
./scripts/migrate.sh

# 8. Start auth (minimum viable service)
pnpm --filter @imajin/auth dev    # localhost:3001

# 9. Register at http://localhost:3001/register
#    This generates a keypair in your browser and creates your identity.
#    SAVE YOUR KEY FILE — it's your only copy.
```

### Minimum Services for Local Dev

You don't need all 15 services. Start with what you need:

| Service | Port | Why |
|---------|------|-----|
| **auth** | 3001 | Required — identity, sessions, registration |
| **profile** | 3005 | User profiles (registration creates one) |
| **registry** | 3002 | App launcher, service discovery |

Add more as needed. Each service's `.env.example` has all the defaults.

### Fresh Start (Reset Everything)

```bash
dropdb imajin_dev && createdb imajin_dev
# Then re-run step 7 above
./scripts/migrate.sh
```

## Setup (Detailed)

```bash
# Clone
git clone https://github.com/ima-jin/imajin-ai.git
cd imajin-ai

# Install all dependencies
pnpm install
```

## Database

### Option A: Local Postgres (recommended for external devs)

Create a database and set `DATABASE_URL` in each service's `.env.local`:

```bash
createdb imajin_dev
```

Run all migrations (each service owns its own Postgres schema):

```bash
./scripts/migrate.sh
```

> **Note:** Tables live in named schemas (`auth`, `profile`, `chat`, etc.) — not in `public`. If your DB browser shows no tables, check the schema dropdown.
>
> **⚠️ Never use `drizzle-kit push`.** It applies schema changes directly without tracking, which breaks `migrate.sh` for everyone else. Always use migration files.

### Option B: SSH Tunnel (team members)

Connect to the server's Postgres:

```bash
ssh -f -N -L 5432:127.0.0.1:5432 jin@192.168.1.193
```

Then use `postgresql://imajin_dev:PASSWORD@localhost:5432/imajin_dev` in your `.env.local`. Schemas are already pushed.

## Environment Variables

Each app needs a `.env.local` file. Start from the example:

```bash
cp apps/auth/.env.example apps/auth/.env.local
# Edit with your DATABASE_URL and secrets
```

### Critical Variables

| Variable | Where | What | How to Generate |
|----------|-------|------|-----------------|
| `DATABASE_URL` | All services | Postgres connection | Your local Postgres URL |
| `AUTH_PRIVATE_KEY` | auth only | Ed25519 PKCS#8 key for signing JWTs | See below |
| `NEXT_PUBLIC_DISABLE_INVITE_GATE` | auth only | Skip invite codes in dev | Set to `true` |
| `NEXT_PUBLIC_SERVICE_PREFIX` | All services | URL pattern for cross-service links | `http://localhost:` for local dev |

### Service URL Pattern

The `.env.example` files default to `NEXT_PUBLIC_SERVICE_PREFIX=http://localhost:` which uses the canonical port map for cross-service browser links. No CORS issues, no hitting production by accident.

Service-to-service (server-side) URLs use `AUTH_SERVICE_URL=http://localhost:3001` etc.

## Running Services

```bash
# Run a single service in dev mode
pnpm --filter @imajin/auth dev         # localhost:3001
pnpm --filter @imajin/events dev       # localhost:3006
pnpm --filter @imajin/learn-service dev # localhost:3103

# Build a service
pnpm --filter @imajin/www build

# Build all
pnpm build
```

### Port Assignments

See [ENVIRONMENTS.md](./ENVIRONMENTS.md) for the full port table. The convention:

- `3xxx` = dev, `7xxx` = prod
- `x000-x099` = core platform
- `x100-x199` = imajin apps
- `x400-x499` = client apps

## Shared Packages

Code shared across services lives in `packages/`:

| Package | What it does |
|---------|-------------|
| `@imajin/auth` | Ed25519 signing, DIDs, identity |
| `@imajin/db` | Database (postgres-js + drizzle-orm) |
| `@imajin/pay` | Stripe + Solana payments |
| `@imajin/ui` | Shared React components (NavBar, Footer) |
| `@imajin/input` | Input widgets (emoji, voice, GPS, upload) |
| `@imajin/media` | Media browser components |
| `@imajin/fair` | .fair attribution standard |
| `@imajin/onboard` | `<OnboardGate>` — anonymous → soft DID onboarding |
| `@imajin/email` | Email sending (SendGrid), templates, QR codes |
| `@imajin/trust-graph` | Trust graph queries for connection checks |
| `@imajin/config` | Shared configuration |

### When shared packages change

If you edit a shared package (e.g., `@imajin/ui`), the consuming app may not pick it up due to Next.js incremental build caching.

Fix: delete the build cache and rebuild:

```bash
cd apps/events
rm -rf .next
pnpm build
```

## Database Schemas

Each service owns a Postgres schema within the shared database. They don't share tables — only the database.

| Schema | Service | Key tables |
|--------|---------|-----------|
| `auth` | auth | identities, sessions, challenges |
| `profile` | profile | profiles |
| `notify` | notify | notifications, preferences |
| `events` | events | events, tickets |
| `coffee` | coffee | pages, tips |
| `chat` | chat | conversations, messages |
| `connections` | connections | connections |
| `media` | media | assets, folders |
| `learn` | learn | courses, modules, lessons, enrollments, lesson_progress |

### Migration Discipline

**Every PR that modifies a `schema.ts` file MUST include the generated migration file.**

The migration runner (`./scripts/migrate.sh`) applies SQL files from each service's `drizzle/` folder. If you change the schema without generating a migration, other developers' databases will be out of sync.

**The rules:**

1. **Never use `drizzle-kit push`.** It applies changes directly to the database with no migration record. The next person who runs `migrate.sh` gets errors because their tracker doesn't know the change was already applied. Push is banned.

2. **Always use `drizzle-kit generate`.** Never hand-write SQL migration files. Every schema change, no matter how small:

```bash
# 1. Make your schema changes in src/db/schema.ts
# 2. Generate the migration (from the app directory!)
cd apps/<service>
npx drizzle-kit generate

# 3. Verify THREE files were created/updated:
#    - drizzle/000N_<name>.sql        (the migration SQL)
#    - drizzle/meta/_journal.json     (migration registry)
#    - drizzle/meta/000N_snapshot.json (schema snapshot)
#
# 4. Commit ALL THREE with your schema.ts change
```

**⚠️ If you drop a .sql file into drizzle/ without running `drizzle-kit generate`, the journal won't know it exists and `migrate.sh` will silently skip it.** CI will catch this — the `check-migrations` job verifies that sql/journal/snapshot counts match.

3. **Make initial migrations idempotent.** Use `CREATE SCHEMA IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, and `CREATE INDEX IF NOT EXISTS` in `0000_*.sql` files.

4. **Test your migration.** Run `./scripts/migrate.sh <service>` locally before pushing.

If `drizzle-kit generate` prompts about column renames, choose **"create column"** unless you are intentionally renaming (rename loses existing data by default).

To inspect the schema interactively:

```bash
cd apps/SERVICE
npx drizzle-kit studio
```

## Adding a New Service

1. **Copy an existing app** (e.g., `apps/coffee`) as a starting point
2. **Update `package.json`**: name, port in dev script
3. **Create schema**: new pgSchema in `src/db/schema.ts`
4. **Copy auth lib**: `src/lib/auth.ts` from any existing app
5. **Create `.env.example`** with required variables
6. **Assign port**: follow the convention in ENVIRONMENTS.md
7. **Build and verify**: `pnpm --filter @imajin/new-service build`

See [DEPLOYMENT.md](../DEPLOYMENT.md) for server-side setup (pm2, Caddy, DNS).

## Code Patterns

### Auth

Every service validates sessions the same way — call the auth service:

```typescript
import { requireAuth, requireHardDID, getSession } from '@/lib/auth';

// In API routes — require any auth
const authResult = await requireAuth(request);
if ('error' in authResult) return errorResponse(authResult.error, authResult.status);

// Require hard DID (keypair-based, not magic link)
const authResult = await requireHardDID(request);

// In server components
const session = await getSession();
```

### API Routes

Next.js App Router API routes in `app/api/`:

```typescript
import { NextRequest } from 'next/server';
import { jsonResponse, errorResponse } from '@/lib/utils';

export async function GET(request: NextRequest) {
  // ...
  return jsonResponse(data);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  // ...
  return jsonResponse(created, 201);
}
```

### ID Generation

All IDs use a prefix + timestamp + random pattern:

```typescript
function generateId(prefix: string): string {
  const random = crypto.randomUUID().replace(/-/g, '').substring(0, 13);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}${random}`;
}

// Examples: crs_m1abc123, lsn_m1def456, enr_m1ghi789
```

## Testing

- **End-to-end test cases:** `tests/HAPPY_PATH.md`
- **Security audit checklist:** `tests/AUDIT.md`

## Troubleshooting

### "Module not found" for shared packages

Run `pnpm install` from the repo root. Workspace dependencies resolve via pnpm's workspace protocol.

### Changes not appearing after build

The build cache may be stale. Delete `.next` and rebuild:

```bash
rm -rf apps/SERVICE/.next
pnpm --filter @imajin/SERVICE build
```

### Database connection errors

If developing locally, ensure your SSH tunnel is running:

```bash
ssh -f -N -L 5432:127.0.0.1:5432 jin@192.168.1.193
```

### Build fails with "DATABASE_URL not set"

Some services need DATABASE_URL at build time (for drizzle schema imports). Set a dummy value:

```bash
DATABASE_URL="postgresql://x:x@localhost:5432/x" pnpm --filter @imajin/SERVICE build
```
