# PATTERNS.md — Canonical Code Patterns

**Read this before writing any code.** This is the source of truth for how things are done in this monorepo. Follow these patterns exactly — don't invent alternatives.

---

## Project Structure

```
apps/           # Next.js applications (each is a service)
packages/       # Shared libraries consumed by apps
  auth/         # Auth utilities (shared across apps that aren't the auth service)
  config/       # Shared config
  db/           # Database client (@imajin/db)
  email/        # Email sending (@imajin/email)
  fair/         # .fair attribution (@imajin/fair)
  input/        # Input validation
  media/        # Media handling
  pay/          # Payment integration
  trust-graph/  # Trust graph + invites schema
  ui/           # Shared React components (@imajin/ui)
```

Each app has:
```
apps/SERVICE/
  app/              # Next.js App Router pages and API routes
  src/
    db/
      index.ts      # DB instance: createDb(schema) from @imajin/db
      schema.ts     # Drizzle schema for this service's tables
    lib/
      auth.ts       # Auth helpers (requireAuth, getSession, etc.)
      ...           # Service-specific helpers
```

---

## Database

### Client

Use `@imajin/db` for all database access. Two patterns:

**Drizzle ORM (preferred for typed queries):**
```ts
import { db, events, ticketTypes } from '@/src/db';
import { eq, and } from 'drizzle-orm';

const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
```

**Raw SQL (for cross-schema queries or complex joins):**
```ts
import { getClient } from '@imajin/db';
const sql = getClient();

const rows = await sql`
  SELECT pm.did FROM connections.pod_members pm
  WHERE pm.pod_id = ${podId} AND pm.role = 'cohost'
`;
```

Use raw SQL when querying across schemas (e.g., events app querying `connections.pod_members`). Use Drizzle for queries within the service's own schema.

### Schema

Each service owns a Postgres schema (namespace):
- `events.events`, `events.tickets`, `events.ticket_types`
- `connections.invites`, `connections.pod_members`
- `dykil.surveys`, `dykil.survey_responses`
- `profiles.profiles`

Define schemas in `apps/SERVICE/src/db/schema.ts` using Drizzle's `pgSchema`:
```ts
import { pgSchema, text, timestamp } from 'drizzle-orm/pg-core';
export const events_schema = pgSchema('events');

export const events = events_schema.table('events', {
  id: text('id').primaryKey(),
  // ...
});
```

### Schema Changes

**DO NOT use `drizzle-kit push`.** It prompts interactively and can drop data.

Use raw SQL via psql:
```sql
ALTER TABLE schema.table ADD COLUMN IF NOT EXISTS column_name TYPE DEFAULT value;
```

---

## Authentication

### API Routes

Use `requireAuth` for endpoints that need a logged-in user:
```ts
import { requireAuth } from '@/src/lib/auth';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  const { identity } = authResult;
  // identity.id = DID, identity.tier = 'soft' | 'hard'
}
```

Use `requireHardDID` when the action requires a keypair-based identity (not email magic link):
```ts
import { requireHardDID } from '@/src/lib/auth';
```

### Server Components

Use `getSession` for server-side rendering:
```ts
import { getSession } from '@/src/lib/auth';

const session = await getSession(); // null if not logged in
if (session) {
  // session.id = DID
}
```

### Authorization (Events App)

**Always use the shared helper. Never inline auth checks.**

```ts
import { isEventOrganizer } from '@/src/lib/organizer';

const orgCheck = await isEventOrganizer(eventId, identity.id);
if (!orgCheck.authorized) {
  return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
}
// orgCheck.role = 'creator' | 'admin' | 'cohost'
```

This checks: creator → eventAdmins table → pod_members (cohost).

**Creator-only actions** (use `orgCheck.role === 'creator'`):
- Publishing/pausing/cancelling events (status changes)
- Issuing refunds (money involved)
- Adding cohosts

---

## API Routes

### Standard Structure

```ts
import { NextRequest, NextResponse } from 'next/server';
import { db, tableName } from '@/src/db';
import { requireAuth } from '@/src/lib/auth';
import { eq } from 'drizzle-orm';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  // ...
  return NextResponse.json({ data });
}
```

### Error Responses

Always return `{ error: string }` with appropriate status:
```ts
return NextResponse.json({ error: 'Not found' }, { status: 404 });
return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
return NextResponse.json({ error: 'Field "name" is required' }, { status: 400 });
```

### CORS (Cross-Service APIs like Dykil)

Services called from other origins (e.g., dykil embedded in events) use CORS helpers:
```ts
import { jsonResponse, errorResponse, corsHeaders, corsOptions } from '@/lib/utils';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  return jsonResponse({ data }, 200, cors);
}
```

---

## Identity & DIDs

- **Format:** `did:imajin:{base58(publicKey)}` for hard DIDs (Ed25519 keypair)
- **Soft DIDs:** `did:email:user_at_domain` (magic link auth, limited capabilities)
- **localStorage keys:** `imajin_keypair`, `imajin_did` (NOT `imajin:keypair`)
- **Session cookie:** `imajin_session` (cross-subdomain)

### Login Flow

Login lives at `auth.imajin.ai/login`. All other apps redirect there:
```ts
const loginUrl = `${AUTH_URL}/login?next=${encodeURIComponent(window.location.href)}`;
```

Use `?next=` (not `?redirect=`).

---

## Cross-Service Communication

Services call each other via internal HTTP:
```ts
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL;
const res = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
  headers: { Cookie: `imajin_session=${token}` },
  cache: 'no-store',
});
```

**All URLs come from environment variables.** Never hardcode service URLs.

---

## iframe Embeds (Dykil → Events)

When embedding one service in another via iframe:

**Parent (events) — listens for messages:**
```ts
window.addEventListener('message', (event) => {
  if (!event.origin.includes('dykil')) return; // Validate origin
  if (event.data.type === 'survey-completed') { /* ... */ }
});
```

**Child (dykil embed) — sends messages to parent:**
```ts
window.parent.postMessage({ type: 'survey-completed', surveyId }, '*');
```

Use `'*'` as target origin (the parent could be any service). The parent validates the source origin.

---

## Next.js Conventions

### Build

- Build individual apps: `cd apps/SERVICE && npx next build`
- **Never** mix root `pnpm build` with per-app `npx next build` — cache corruption
- If cache seems wrong: `rm -rf .next && npx next build`
- After building: `pm2 restart SERVICE`

### Server Components vs Client Components

- Default to server components (no `'use client'` directive)
- Use `'use client'` only when you need: useState, useEffect, onClick, browser APIs
- Fetch data in server components, pass to client components as props

### Imports

```ts
// Package imports
import { db, events } from '@/src/db';           // Service's own DB
import { getClient } from '@imajin/db';           // Raw SQL client
import { requireAuth } from '@/src/lib/auth';     // Auth helpers
import { isEventOrganizer } from '@/src/lib/organizer'; // Events auth

// Drizzle operators
import { eq, and, or, ne, isNull, inArray, desc } from 'drizzle-orm';
```

---

## Commit & Deploy

- Commit messages: `fix:`, `feat:`, `refactor:`, `chore:`
- Add `[skip ci]` to skip broken CI pipeline
- Deploy: edit locally → push to GitHub → pull on server → build → pm2 restart
- **Never edit code on the server**

---

## Anti-Patterns (Don't Do These)

❌ Inline auth checks — use `isEventOrganizer()` or `requireAuth()`
❌ Hardcoded service URLs — use env vars
❌ `drizzle-kit push` — use raw SQL ALTER TABLE
❌ `pnpm build` from root then `npx next build` per app — cache corruption
❌ Editing code on the server
❌ `?redirect=` parameter — use `?next=`
❌ `imajin:keypair` localStorage key — use `imajin_keypair`
❌ Returning errors without `{ error: string }` format
❌ Cross-schema queries via Drizzle — use raw SQL with `getClient()`
