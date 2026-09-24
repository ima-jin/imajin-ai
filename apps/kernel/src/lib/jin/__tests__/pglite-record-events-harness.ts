/**
 * Real-engine harness for `record-events.ts` (#2289), mirroring the
 * rationale in `src/lib/pay/__tests__/pglite-pay-harness.ts`: the scoping
 * predicate this module builds relies on real Postgres JSONB (`->>`)
 * semantics and a `LEFT JOIN` — a hand-rolled fake Drizzle executor can
 * only prove the code called the mock with some arguments, never that a
 * real engine actually enforces "principal A cannot read principal B's
 * events" (the #2289 acceptance criterion this suite exists to prove).
 *
 * Unlike the pay harness, this one does NOT replay real migration files.
 * `operator.approvals` (migration 0130) INSERTs into `kernel.bus_chain_configs`
 * (migration 0037) as a side effect, which would drag in that table (and
 * its own dependents) purely as migration-ordering plumbing unrelated to
 * anything this suite exercises. Instead, the four tables the service
 * actually reads (`registry.system_events`, `operator.approvals`,
 * `auth.identity_members`, `auth.delegation_grants`) are created directly
 * here, column-for-column matching the Drizzle schemas in
 * `src/db/schemas/{registry,operator-approvals,auth}.ts` — kept in sync
 * with those schemas the same way the pay harness is kept in sync with
 * its migration list.
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { systemEvents } from '@/src/db/schemas/registry';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';
import { identityMembers, delegationGrants } from '@/src/db/schemas/auth';

const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS registry;
CREATE SCHEMA IF NOT EXISTS operator;
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS registry.system_events (
  id text PRIMARY KEY,
  service text NOT NULL,
  action text NOT NULL,
  did text,
  correlation_id text,
  parent_event_id text,
  payload jsonb,
  status text DEFAULT 'success',
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS operator.approvals (
  proposal_id text PRIMARY KEY,
  operator_did text NOT NULL,
  source text NOT NULL DEFAULT 'system-agent',
  kind text NOT NULL,
  summary text NOT NULL,
  keys_touched jsonb NOT NULL DEFAULT '[]',
  detail jsonb,
  content_hash text,
  notification_id text,
  signer_did text,
  status text NOT NULL DEFAULT 'pending',
  decision jsonb,
  outcome jsonb,
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth.identity_members (
  identity_did text NOT NULL,
  member_did text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  added_by text,
  added_at timestamptz DEFAULT now(),
  removed_at timestamptz,
  allowed_services text[],
  added_via text,
  opt_in_ref text
);

CREATE TABLE IF NOT EXISTS auth.delegation_grants (
  id text PRIMARY KEY,
  agent_did text NOT NULL,
  delegator_did text NOT NULL,
  audience jsonb NOT NULL,
  on_behalf_of jsonb NOT NULL DEFAULT '[]',
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'active',
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

type RecordEventsSchema = {
  systemEvents: typeof systemEvents;
  operatorApprovals: typeof operatorApprovals;
  identityMembers: typeof identityMembers;
  delegationGrants: typeof delegationGrants;
};

export type RecordEventsConnection = PgliteDatabase<RecordEventsSchema>;

export interface RecordEventsHarness {
  client: PGlite;
  db: RecordEventsConnection;
  close(): Promise<void>;
}

/** Boot a throwaway `@electric-sql/pglite` instance with exactly the tables `record-events.ts` reads. */
export async function createRecordEventsHarness(): Promise<RecordEventsHarness> {
  const client = new PGlite({ extensions: { pgcrypto } });
  await client.waitReady;
  await client.exec(SCHEMA_SQL);

  const schema: RecordEventsSchema = { systemEvents, operatorApprovals, identityMembers, delegationGrants };
  const db = drizzle(client, { schema });

  return {
    client,
    db,
    async close() {
      await client.close();
    },
  };
}
