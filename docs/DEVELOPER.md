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
- Writes the kernel's `.env.local` with local service URLs pointing to the consolidated kernel at `:3000`. All extracted verticals are set up separately in their own repos: [ima-jin/events](https://github.com/ima-jin/events) (#2517), [ima-jin/links](https://github.com/ima-jin/links), [ima-jin/learn](https://github.com/ima-jin/learn), [ima-jin/coffee](https://github.com/ima-jin/coffee), [ima-jin/market](https://github.com/ima-jin/market) and [ima-jin/dykil](https://github.com/ima-jin/dykil).
- Runs all migrations via `./scripts/migrate.sh`

### Minimum Services for Local Dev

You don't need to run all apps. Start with what you need:

| Service | Port | Why |
|---------|------|-----|
| **kernel** | 3000 | Required — auth, identity, profile, registry, and all core platform services |

Add userspace apps as needed from their standalone repositories. For events, follow [its owned README](https://github.com/ima-jin/events/blob/main/README.md); it is not a workspace filter target here. Its existing ports (3006 dev / 7006 prod) and `/events` routing prefix are unchanged.

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
### App secrets and import ordering (#2821)

Registered apps can declare names/kinds in `imajin.app.json`: generated
`random-32B`/`random-64B` or `operator-supplied` for existing/external strings.
Never put values in that manifest. Operator values go through the masked `/jin`
set/rotate input and a separate verified human countersign. Sealed pending
staging is not an active credential; responses, approval cards and diagnostics
must not echo submitted values or underlying provider messages.

For runtime adoption, establish the app bootstrap keystore with
`loadAppSigningKey()`, then use `createVaultBoot<Config>({ vault, configure })`
from the released `@ima-jin/auth-client`. Keep its instance in a server-only
config module. `boot.start(callback)` loads credentials into typed in-memory
configuration **before** the callback dynamically imports/starts the server.
DB modules evaluated during that import read `boot.getConfig().DATABASE_URL`;
refactor existing env-reading consumers instead of assigning secrets to
`process.env`. An eager static DB/server import still initializes too early.
The complete example and regression command are in the
[app author guide](app-self-secrets-author.md#pre-import-boot-boundary-for-database-consumers).

Start follow-up adoption with events/coffee/learn/market/links `DATABASE_URL`,
then use the [full adoption inventory](app-self-secrets-author.md#adoption-order-follow-up-work-not-an-automatic-cutover)
for the remaining app/environment keys. Coffee `WEBHOOK_SECRET` is vestigial
and excluded. This feature does not migrate standalone repositories or change
server/env/deploy files. Approvals do not restart apps: coordinate the next
restart and session invalidation when rotating `SESSION_SECRET`. #2260 remains
separate. Feature PRs never bump package versions; consume the helper through
the normal reviewed Release workflow, with no promised hard-coded version.

### Service URL Pattern

The `.env.example` files default to `NEXT_PUBLIC_SERVICE_PREFIX=http://localhost:` which uses the canonical port map for cross-service browser links. No CORS issues, no hitting production by accident.

Service-to-service (server-side) URLs use `AUTH_SERVICE_URL=http://localhost:3001` etc.

## Running Services

```bash
# Run a single service in dev mode
pnpm --filter @imajin/kernel dev       # localhost:3000

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

## Interactive Runs on /jin (#2404)

The Runs lane uses the existing principal-scoped loop registry, not a harness
API. Threads are a lineage tree; Blocked-on-you combines blocked loops and the
same pending approval cards shown in the operator Inbox. Opening a thread shows
typed signed events, a composer, stop and child-spawn controls. A surface
collision warns on both threads without preventing commands.

`POST /jin/api/runs/{loopId}/commands` prepares a short-lived command with
`action: "prepare"`, `type: "session.send" | "session.abort" | "session.spawn"`
and a bounded `payload`. The target is `payload.loopId` (send/stop) or
`payload.parentLoopId` (spawn); spawn also accepts task, label, group and model.
The server resolves the verified originating agent, not a client-selected DID.
After signing the complete prepared command in the browser, the operator
submits it with `action: "dispatch"` and `command`. The principal's private key
never leaves the browser. A missing key, stale grant, revoked binding, ended
loop or ambiguous publisher fails closed.

Both Ed25519 signatures cover the identical canonical object:
`{type, commandId, to, principal, issuer, issuedAt, expiresAt, payload}`.
The kernel grant and principal wish are checked before the durable correlation
record is claimed and the command is sent only to the target agent's own DID
socket. Delegated notification sockets are not command recipients. Registry
`refs` remain opaque: no session keys are read or forwarded, no gateway RPC is
made, and no transcript is fetched.

Native approval cards acquire a thread association only from a verified
`loop.approval.bound` signed envelope binding
`{loopId, principalDid, agentDid, approvalId}`. Approve/deny still uses
`POST /jin/api/operator-approvals/{proposalId}/decision` and the existing
approval service, with a separate full-command wish. A converted proposal
selects one execution rail atomically and suppresses the legacy executable
`operator.approval.decided` fan-out. An unavailable wish must never silently
fall back to that legacy rail.

Command correlation, signed bindings and outcomes reuse `kernel.loop_events`;
this feature needs no new schema. A socket send means only delivery attempted.
The UI waits for the correlated agent-signed
`loop.session.{send,approve,deny,abort,spawn}.{completed,failed}` observation.
The kernel verifies the authenticated socket DID, current agent key, principal,
command ID, command type and payload hash before recording an outcome. Spawn
lineage is accepted only from the signed child/parent attestation.

The wire fixtures follow
[plugin #77](https://github.com/ima-jin/openclaw-imajin-plugin/issues/77) and
its [command documentation](https://github.com/ima-jin/openclaw-imajin-plugin/blob/issue-77-loop-addressed-sessions/docs/session-commands.md).
A fixture preview is not evidence of a live gateway round-trip: that check
remains pending the separately implemented plugin #77. Do not disable signature
checks or change server/environment settings to make a preview appear live.

## Shared Packages

Code shared across services lives in `packages/`:

| Package | What it does |
|---------|-------------|
| `@imajin/auth` | Ed25519 signing, DIDs, identity |
| `@imajin/db` | Database (postgres-js + drizzle-orm) |
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
cd apps/kernel
rm -rf .next
pnpm build
```

### Publishing a shared package to npm

Some `packages/*` are also published to npm under the `@ima-jin` scope for external consumption (`imajin-cli`, `fixready`, `karaoke`, etc.) — see the [npm publish epic](https://github.com/ima-jin/imajin-ai/issues/1573). If you're normalizing another package for publication, read [`docs/npm-publishing.md`](./npm-publishing.md) first — it covers the in-repo/published-scope mechanism and several gotchas (RSC `'use client'` bundling, tarball leakage, CI wiring) that are easy to miss.

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
| `kernel` | kernel | loops, loop_events, surface_lease (signed warn-only surface holders; migration `0194_surface_lease.sql`) |
| `events` | [standalone events](https://github.com/ima-jin/events) | events, tickets (historical migrations remain unchanged in the kernel repo; no schema/data removal in #2517) |
| `coffee` | coffee | pages, tips |
| `learn` | learn | courses, modules, lessons, enrollments, lesson_progress (app now in [ima-jin/learn](https://github.com/ima-jin/learn), #2503; schema stays here) |

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

Start from [ima-jin/imajin-app-template](https://github.com/ima-jin/imajin-app-template)
in a separate repository, preserving its history. Follow its owned README and the
[registered-app contract](./REGISTRATION.md): scoped tokens, published `@ima-jin/*`
SDK packages and public kernel APIs, never kernel-internal imports or another
service's tables. Configure and build the app using its own setup/deploy scripts;
do not copy a removed monorepo app or add a workspace filter for it here.

See [ENVIRONMENTS.md](./ENVIRONMENTS.md) and [deploy/README.md](../deploy/README.md)
for kernel deployment configuration (pm2, Caddy, DNS).

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

## Loop session output publishers

See [the signed loop output contract](guide/loop-output.md) for the eight
`payload.output` kinds, signing, redaction, storage bounds, and private
artifact retrieval used by the plugin and `/jin` Runs. This uses the existing
database and auth configuration; no new environment variables are required.

## Testing

- **End-to-end test cases:** `tests/HAPPY_PATH.md`
- **Security audit checklist:** `tests/AUDIT.md`

## Linting

Run lint across all packages:

```bash
pnpm lint
```

Config lives in `eslint.config.mjs` at the repo root — a single flat config that applies glob-based rules across all apps and packages. No per-package `.eslintrc.*` files.

**Stack:** ESLint v9 flat config, `typescript-eslint` v8, `eslint-plugin-sonarjs` v2.

All apps use Next.js rules via `FlatCompat` (bridging `eslint-config-next@14` until a Next.js 15 upgrade). All TypeScript files get `@typescript-eslint/recommended`. `packages/eslint-config-imajin` exports reusable flat config arrays for standalone package use.

### SonarJS rules

Two Sonar rules are active repo-wide via `eslint-plugin-sonarjs` v2:

| Rule | Sonar ID | Threshold | Severity |
|------|----------|-----------|----------|
| `sonarjs/cognitive-complexity` | S3776 | 15 | `warn` |
| `sonarjs/no-nested-functions` | S2004 | 4 levels | `warn` |

Both are set to `warn` (visible, non-blocking). They will be promoted to `error` once the SonarCloud cleanup epic (#1466) is closed and the existing violations are cleared.

The same rules run in SonarCloud via its GitHub App. Catching them in ESLint first means you see S3776/S2004 feedback before pushing a PR.

### Adding a rule repo-wide

Edit `eslint.config.mjs` in the repo root. All packages pick it up automatically on the next lint run.

## Typechecking

Run `pnpm typecheck`; it builds type deps first (`build:types`) so workspace packages resolve via `dist/` the same way CI does. If you've already built, `pnpm typecheck:only` skips the rebuild.

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
