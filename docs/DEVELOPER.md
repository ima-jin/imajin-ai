# Developer Guide

Getting started with the imajin-ai monorepo.

## Prerequisites

- **Node.js 22+** (use [nvm](https://github.com/nvm-sh/nvm))
- **pnpm** (`npm install -g pnpm`)
- **PostgreSQL** (local install or SSH tunnel to server)

## Quickstart (Local Dev from Zero)

The setup script handles everything automatically:

```bash
# 1. Clone
git clone https://github.com/ima-jin/imajin-ai.git
cd imajin-ai

# 2. Run setup (checks prereqs, installs deps, creates DB, writes .env.local files, runs migrations)
bash scripts/setup-local.sh

# 3. Start kernel
pnpm --filter @imajin/kernel dev    # http://localhost:3000

# 4. Register at http://localhost:3000/register
#    SAVE YOUR KEY FILE — it's your only copy.
```

The script accepts options for non-default Postgres connections:

```bash
bash scripts/setup-local.sh --db-user=postgres --db-host=localhost --db-port=5432
```

Run with `--help` for all options. Use `--force` to regenerate `.env.local` files (rotates all secrets).

**What the script does:**
- Checks Node.js 22+, pnpm, and PostgreSQL tools
- Runs `pnpm install`
- Creates the `imajin_dev` database (skip if it already exists)
- Generates an Ed25519 keypair (`AUTH_PRIVATE_KEY`) and all internal API keys
- Writes `.env.local` for kernel and every vertical (events, coffee, dykil, links, learn, market) with secrets wired together and service URLs pointing to the consolidated kernel at `:3000`
- Runs all migrations via `./scripts/migrate.sh`

### Minimum Services for Local Dev

You don't need to run all apps. Start with what you need:

| Service | Port | Why |
|---------|------|-----|
| **kernel** | 3000 | Required — auth, identity, profile, registry, and all core platform services |

Add userspace apps (events, coffee, etc.) as needed. Each app's `.env.example` has all the defaults.

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
pnpm --filter @imajin/kernel dev       # localhost:3000
pnpm --filter @imajin/events dev       # localhost:3006
pnpm --filter @imajin/learn-service dev # localhost:3103

# Build a service
pnpm --filter @imajin/kernel build

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
| `auth` | kernel | identities, sessions, challenges |
| `profile` | kernel | profiles |
| `notify` | kernel | notifications, preferences |
| `chat` | kernel | conversations, messages |
| `connections` | kernel | connections |
| `media` | kernel | assets, folders |
| `pay` | kernel | payments, balances |
| `registry` | kernel | nodes, heartbeats |
| `events` | events | events, tickets |
| `coffee` | coffee | pages, tips |
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
cd apps/kernel   # or apps/<userspace-app>
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

## Email Storage Locations

Three places where user email addresses live. The notify service checks them in priority order.

| Table | Column | Set By | Purpose |
|-------|--------|--------|---------|
| `auth.identities` | `contact_email` | Stripe checkout (ticket purchase, onboard with payment) | Billing/notification email from payment flow |
| `profile.profiles` | `contact_email` | Connection invite register form | Profile-level email from registration |
| `www.contacts` + `www.subscriptions` | `email` | Register form (`optInUpdates` checked) OR website subscribe form | Mailing list / newsletter sends only |

**Notify email resolution** (`apps/kernel/app/notify/api/send/route.ts`):
1. `data.email` in the event payload (explicit, e.g. from Stripe webhook)
2. `profile.profiles.contact_email` (primary — connection invite / register flow)
3. `auth.identities.contact_email` (fallback — Stripe / ticket purchases)

`www.contacts` is **not** checked by the notify service — it's a separate broadcast/newsletter system.

**When each gets populated:**
- **Ticket purchase** → `auth.identities.contact_email` (from Stripe checkout email)
- **Connection invite register** → `profile.profiles.contact_email` + optionally `www.contacts`
- **Website subscribe form** → `www.contacts` only (no DID, no identity)
