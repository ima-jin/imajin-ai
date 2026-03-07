# Developer Guide

Getting started with the imajin-ai monorepo.

## Prerequisites

- **Node.js 22+** (use [nvm](https://github.com/nvm-sh/nvm))
- **pnpm** (`npm install -g pnpm`)
- **PostgreSQL** (local install or SSH tunnel to server)

## Setup

```bash
# Clone
git clone https://github.com/ima-jin/imajin-ai.git
cd imajin-ai

# Install all dependencies
pnpm install
```

## Database

### Option A: SSH Tunnel (recommended for dev)

Connect to the server's Postgres:

```bash
ssh -f -N -L 5432:127.0.0.1:5432 jin@192.168.1.193
```

Then use `postgresql://imajin_dev:PASSWORD@localhost:5432/imajin_dev` in your `.env.local`.

### Option B: Local Postgres

Create a database and set `DATABASE_URL` in `.env.local`:

```bash
createdb imajin_dev
```

Push schemas:

```bash
cd apps/auth && DATABASE_URL="postgresql://..." npx drizzle-kit push --force
```

## Environment Variables

Each app needs a `.env.local` file. Start from the example:

```bash
cd apps/events
cp .env.example .env.local
# Edit with your DATABASE_URL and service URLs
```

Key variables every service needs:

| Variable | Example |
|----------|---------|
| `DATABASE_URL` | `postgresql://imajin_dev:pass@localhost:5432/imajin_dev` |
| `AUTH_SERVICE_URL` | `http://localhost:3001` |

Service-to-service URLs must point to wherever each service is running. In local dev, that's `http://localhost:PORT`.

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
| `events` | events | events, tickets |
| `coffee` | coffee | pages, tips |
| `chat` | chat | conversations, messages |
| `connections` | connections | connections |
| `input` | input | transcriptions |
| `media` | media | assets, folders |
| `learn` | learn | courses, modules, lessons, enrollments, lesson_progress |

To push schema changes:

```bash
cd apps/SERVICE
DATABASE_URL="..." npx drizzle-kit push --force
```

To inspect the schema:

```bash
DATABASE_URL="..." npx drizzle-kit studio
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
