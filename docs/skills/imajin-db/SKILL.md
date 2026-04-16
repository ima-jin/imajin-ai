---
name: imajin-db
description: "Work with Imajin's database: Postgres schemas, migrations, drizzle-orm queries, table structures, the plain SQL migration runner. Use when: writing migrations, querying tables, adding columns/indexes, understanding schema relationships, debugging DB issues, setting up new environments. Triggers on: migration, database, schema, table, column, index, drizzle, postgres, getClient, sql, query, seed, migrate.mjs, 0001_seed."
metadata:
  openclaw:
    emoji: "🗄️"
---

# Imajin DB

## Architecture

One Postgres instance, 17 named schemas. All services share the same DB — isolation is at the schema level, not the database level.

**Package:** `@imajin/db` (`packages/db/`) — `postgres-js` + `drizzle-orm`. No Prisma, no Knex.

```typescript
import { getClient } from '@imajin/db';
const sql = getClient();  // postgres-js client from DATABASE_URL
```

**⚠️ Never call `getClient()` at module level.** Move inside request handlers. If DB isn't ready at import time, it throws. (Lesson #31)

### Schema Layout

| Schema | Owner | Tables | Defined in |
|--------|-------|--------|------------|
| `auth` | kernel | identities, tokens, credentials, attestations, identity_members, challenges, onboard_tokens, stored_keys, mfa_methods, devices, identity_chains | `apps/kernel/src/db/schemas/auth.ts` |
| `chat` | kernel | conversations_v2, messages_v2, message_reactions_v2, conversation_reads_v2, conversation_members, invites, public_keys, pre_keys | `apps/kernel/src/db/schemas/chat-v2.ts` + `chat.ts` |
| `connections` | kernel | connections, nicknames, pods, invites, pod_keys, pod_member_keys, pod_links, pod_members | `apps/kernel/src/db/schemas/connections.ts` |
| `media` | kernel | assets, folders, asset_folders, asset_references | `apps/kernel/src/db/schemas/media.ts` |
| `notify` | kernel | notifications, preferences | `apps/kernel/src/db/schemas/notify.ts` |
| `pay` | kernel | transactions, balances, balance_rollups, connected_accounts, fee_ledger | `apps/kernel/src/db/schemas/pay.ts` |
| `profile` | kernel | profiles, follows, query_logs, forest_config, profile_images | `apps/kernel/src/db/schemas/profile.ts` |
| `registry` | kernel | nodes, approved_builds, heartbeats, trust, interests, did_preferences, did_interests, bump_sessions, bump_events, bump_matches, newsletter_sends, node_config, flags, moderation_log, request_log, system_events, app_logs | `apps/kernel/src/db/schemas/registry.ts` |
| `relay` | kernel | relay_operations, relay_identity_chains, relay_content_chains, relay_beacons, relay_blobs, relay_countersignatures, relay_pending_operations, relay_peer_cursors, relay_config, relay_operation_log, relay_revocations, relay_public_credentials, relay_documents | `apps/kernel/src/db/schemas/relay.ts` |
| `www` | kernel | contacts, mailing_lists, subscriptions, bug_reports | `apps/kernel/src/db/schemas/www.ts` |
| `events` | events | events, ticket_types, orders, tickets, ticket_transfers, ticket_queue, event_invites, ticket_registrations | `apps/events/src/db/schema.ts` |
| `coffee` | coffee | pages, tips | `apps/coffee/src/db/schema.ts` |
| `market` | market | listings, disputes, seller_settings | `apps/market/src/db/schema.ts` |
| `learn` | learn | courses, modules, lessons, enrollments, lesson_progress | `apps/learn/src/db/schema.ts` |
| `links` | links | pages, links, clicks | `apps/links/src/db/schema.ts` |
| `dykil` | dykil | surveys, survey_responses | `apps/dykil/src/db/schema.ts` |

Kernel schemas are defined in `apps/kernel/src/db/schemas/*.ts`. Userspace app schemas are in `apps/<app>/src/db/schema.ts`.

## Migrations

### Plain SQL Runner

All migrations live in `migrations/` at the repo root. Sequential numbering, explicit ordering, fully idempotent DDL.

```
migrations/
  0001_seed.sql              # Baseline — full schema from dev snapshot
  0002_relay_081.sql         # DFOS relay 0.8.1 tables
  0003_drop_drizzle_tracking.sql  # Cleanup old tracking
  0004_*.sql                 # Next migration
```

**Runner:** `scripts/migrate.mjs`
- Tracking table: `public._migrations` (filename + SHA-256 checksum)
- Each migration runs in its own transaction
- Tracking row inserted only on success (no phantom rows)
- Changed checksum → warn but skip (DDL is idempotent)
- `DATABASE_URL` read from `apps/kernel/.env.local` or environment

```bash
# Run pending migrations
node scripts/migrate.mjs

# Or via wrapper
./scripts/migrate.sh
```

**Deploy integration:** `scripts/build.sh` runs `node scripts/migrate.mjs` before building. CI workflows (`deploy-dev.yml`, `deploy-prod.yml`) do the same.

### Writing a New Migration

1. Create `migrations/NNNN_description.sql` (next sequential number, 4-digit padded)
2. **All DDL must be idempotent:**
   - `CREATE TABLE IF NOT EXISTS`
   - `CREATE INDEX IF NOT EXISTS`
   - `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
   - For constraints: `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN NULL; END $$`
   - `DROP TABLE IF EXISTS` / `DROP COLUMN IF EXISTS`
3. Use schema-qualified names everywhere (`auth.identities`, not `identities`)
4. Commit the .sql file — it runs automatically on next deploy

### Generating Migration SQL from Schema Changes

Drizzle-kit is still available for scaffolding:

```bash
cd apps/kernel  # or whichever app
npx drizzle-kit generate
```

This generates SQL in the app's `drizzle/` folder. **Move the output to `migrations/`**, rename with the next sequential number, and add idempotent guards. Don't leave SQL in per-app drizzle folders.

### Setting Up a New Environment

```bash
# Fresh database — run all migrations
node scripts/migrate.mjs

# Existing database — mark migrations as applied first
node scripts/seed-migrations.mjs
# Then run to apply any new ones
node scripts/migrate.mjs
```

### CI Validation

`scripts/check-migrations.sh` validates:
- Sequential numbering (NNNN_*.sql format)
- No gaps in numbering
- No empty files

## Querying with Drizzle

### Basic Patterns

```typescript
import { getClient } from '@imajin/db';
import { eq, and, desc, sql } from 'drizzle-orm';
import { identities } from '@/src/db/schemas/auth';

// Inside a request handler (never at module level)
const db = getClient();

// Select
const user = await db.select().from(identities).where(eq(identities.id, did)).limit(1);

// Insert
await db.insert(identities).values({ id: did, name, handle, scope, subtype, tier });

// Update
await db.update(identities).set({ name: newName }).where(eq(identities.id, did));

// Upsert
await db.insert(identities).values({ ... })
  .onConflictDoUpdate({ target: identities.id, set: { name: newName } });
```

### Cross-Schema Joins

Services share the same DB, so cross-schema joins work:

```typescript
import { profiles } from '@/src/db/schemas/profile';
import { identities } from '@/src/db/schemas/auth';

const result = await db
  .select({ name: identities.name, avatar: profiles.avatar })
  .from(identities)
  .leftJoin(profiles, eq(identities.id, profiles.did))
  .where(eq(identities.id, did));
```

### Raw SQL

```typescript
const result = await sql`SELECT COUNT(*) FROM auth.identities WHERE tier = 'preliminary'`;
```

## Databases

| Database | Owner | Used By | Port |
|----------|-------|---------|------|
| `imajin_dev` | `imajin_dev` | All services (dev) | 5432 |
| `imajin_prod` | `imajin` | All services (prod) | 5432 |
| `fixready_dev` | `imajin_dev` | fixready (dev) | 5432 |
| `fixready_prod` | `imajin` | fixready (prod) | 5432 |
| `karaoke_dev` | `imajin_dev` | karaoke (dev) | 5432 |
| `karaoke_prod` | `imajin` | karaoke (prod) | 5432 |

All on `192.168.1.193`, open to LAN (192.168.1.0/24).

## Lessons

- **All DDL must be idempotent.** `IF NOT EXISTS` everywhere. Drizzle migrations that ran partially leave phantom tracking rows. (#684)
- **Never call `getClient()` at module level.** Dynamic import inside handlers only. (#706)
- **`onConflictDoNothing` swallows reconnects.** Soft-deleted rows still conflict on PK. Use `onConflictDoUpdate` to clear soft-delete flags. (#647)
- **Two agents, one schema = divergence.** Scope one agent per schema change. (#704)
- **One migration runner for everything.** No per-service tracking, no hash-based checksums that break on fixes. Sequential numbering solves ordering.
- **`drizzle-kit push` is banned.** Applies schema changes without tracking. Always use migration files.
- **Variable naming: don't shadow imports.** `const events = createEmitter('events')` in an app that imports an `events` table → SWC rejects the redefinition.
