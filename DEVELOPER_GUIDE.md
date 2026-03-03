# Developer Guide

Local development setup for the Imajin monorepo on macOS.

## Prerequisites

- macOS
- [Homebrew](https://brew.sh)
- Node.js 20+
- pnpm 9+
- PostgreSQL 16

## 1. Install Homebrew (if needed)

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

Follow the printed instructions to add Homebrew to your PATH.

## 2. Install Node.js

```bash
brew install node@20
```

Verify:

```bash
node -v  # Should print v20.x.x
```

## 3. Install pnpm

```bash
brew install pnpm
```

Or via npm:

```bash
npm install -g pnpm@9
```

Verify:

```bash
pnpm -v  # Should print 9.x.x
```

## 4. Install and Start PostgreSQL

```bash
brew install postgresql@16
brew services start postgresql@16
```

Verify it's running:

```bash
brew services list | grep postgresql
```

Create the database:

```bash
createdb imajin
```

If `createdb` is not found, add the PostgreSQL bin to your PATH:

```bash
echo 'export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
createdb imajin
```

## 5. Configure Environment Variables

Each app that uses a database or communicates with other services needs a `.env.local` file.

### apps/auth/.env.local

```env
DATABASE_URL=postgres://localhost:5432/imajin

# Generate a stable key so sessions survive server restarts:
#   node -e "const c=require('crypto');const{privateKey}=c.generateKeyPairSync('ed25519');console.log(privateKey.export({type:'pkcs8',format:'der'}).toString('hex'))"
AUTH_PRIVATE_KEY=<paste generated key here>

CONNECTIONS_SERVICE_URL=http://localhost:3008

NEXT_PUBLIC_DISABLE_INVITE_GATE=true
NEXT_PUBLIC_SERVICE_PREFIX=http://localhost:
NEXT_PUBLIC_DOMAIN=imajin.ai
```

### apps/profile/.env.local

```env
DATABASE_URL=postgres://localhost:5432/imajin
AUTH_SERVICE_URL=http://localhost:3003

NEXT_PUBLIC_DISABLE_INVITE_GATE=true
NEXT_PUBLIC_WWW_URL=http://localhost:3000
NEXT_PUBLIC_AUTH_URL=http://localhost:3003
NEXT_PUBLIC_EVENTS_URL=http://localhost:3007
NEXT_PUBLIC_PROFILE_URL=http://localhost:3005
```

### apps/events/.env.local

```env
DATABASE_URL=postgres://localhost:5432/imajin
AUTH_SERVICE_URL=http://localhost:3003

NEXT_PUBLIC_WWW_URL=http://localhost:3000
NEXT_PUBLIC_AUTH_URL=http://localhost:3003
NEXT_PUBLIC_EVENTS_URL=http://localhost:3007
NEXT_PUBLIC_PROFILE_URL=http://localhost:3005
```

Other apps that use a database should have at minimum:

```env
DATABASE_URL=postgres://localhost:5432/imajin
AUTH_SERVICE_URL=http://localhost:3003
```

## 6. Install Dependencies

```bash
pnpm install --frozen-lockfile
```

## 7. Setup Database Schema

The database uses **Postgres schema isolation** — each service has its own schema (namespace) to prevent table name conflicts.

### Fresh Setup (New Database)

Reset the database and create all schemas:

```bash
pnpm db:reset
```

This will:
1. Drop all service schemas
2. Recreate them
3. Push each service's schema via drizzle-kit
4. Seed essential data (Jin profile)

### Adding Demo Data (Optional)

Create `scripts/launch-local.ts` from the example template:

```bash
cp scripts/launch-local.example.ts scripts/launch-local.ts
```

Edit it to add your own test data, then run:

```bash
tsx scripts/launch-local.ts
```

### Migrating Existing Data

If you have an existing database with tables in the `public` schema, migrate them:

```bash
pnpm db:migrate
```

This moves tables from `public` to their service-specific schemas (e.g., `auth_identities` → `auth.identities`).

### Manual Schema Push

To push a single service's schema:

```bash
cd apps/auth
DATABASE_URL=postgres://localhost:5432/imajin pnpm drizzle-kit push
```

### Available Scripts

- `pnpm db:reset` — Drop all schemas, recreate, and seed
- `pnpm db:migrate` — Migrate tables from public schema to service schemas (one-time)
- `pnpm db:seed` — Seed essential data (Jin profile)

## 8. Run the Dev Server

```bash
pnpm dev
```

This starts all services in parallel.

## Service Ports

| Service     | Port | URL                      |
|-------------|------|--------------------------|
| www         | 3000 | http://localhost:3000     |
| auth        | 3003 | http://localhost:3003     |
| pay         | 3004 | http://localhost:3004     |
| profile     | 3005 | http://localhost:3005     |
| registry    | 3006 | http://localhost:3006     |
| events      | 3007 | http://localhost:3007     |
| connections | 3008 | http://localhost:3008     |
| coffee      | 3009 | http://localhost:3009     |
| links       | 3010 | http://localhost:3010     |
| learn       | 3011 | http://localhost:3011     |
| dykil       | 3012 | http://localhost:3012     |
| chat        | 3013 | http://localhost:3013     |

## Getting Started

1. Open http://localhost:3005/register to create a new identity
2. Your keypair backup file will be downloaded automatically — keep it safe, it's your login credential
3. Visit http://localhost:3007 to browse and create events
4. Visit http://localhost:3005 to view your profile

## Troubleshooting

### "column X does not exist" errors

The database schema is out of sync. Re-run the schema push from step 7.

### JWT signature verification failed

The `AUTH_PRIVATE_KEY` was not set or changed. Clear the `imajin_session` cookie from your browser (DevTools > Application > Cookies) and register/login again.

### Session 401 errors after server restart

If `AUTH_PRIVATE_KEY` is not set in `apps/auth/.env.local`, a new ephemeral key is generated on every restart, invalidating all existing sessions. Set a stable key as described in step 5.
