/**
 * Real-engine harness for the connector-Inbox suites (#2723): the two tables
 * a connector proposal touches end to end — `operator.approvals` (the Inbox
 * row) and `github.action_proposals` (the write-gate ledger an approval
 * flips). Real Postgres semantics matter here: the Inbox read widens its
 * candidate set with a JSONB `->>` predicate, and the backlog re-address is a
 * guarded UPDATE whose idempotency/race-safety a hand-rolled fake executor
 * could only echo back, never prove.
 *
 * `operator.approvals` DDL is shared with the record-events harness; the
 * ledger DDL matches `src/db/schemas/github.ts` column for column.
 */
import { afterAll, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/pglite';
import type { PgliteDatabase } from 'drizzle-orm/pglite';
import { operatorApprovals } from '@/src/db/schemas/operator-approvals';
import { githubActionProposals } from '@/src/db/schemas/github';
import { OPERATOR_APPROVALS_TABLE_SQL } from '@/src/lib/jin/__tests__/pglite-record-events-harness';
import { CONNECTOR_OWNER_DID, OPERATOR_DID, githubProposalDetail } from './operator-approvals-test-helpers';

const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS operator;
CREATE SCHEMA IF NOT EXISTS github;

${OPERATOR_APPROVALS_TABLE_SQL}

CREATE TABLE IF NOT EXISTS github.action_proposals (
  id text PRIMARY KEY,
  owner_did text NOT NULL,
  agent_did text,
  scope text NOT NULL,
  tool text NOT NULL,
  risk_tier text NOT NULL,
  target text NOT NULL,
  args_summary text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  approved_until timestamptz,
  owner_authorization jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

type ConnectorInboxSchema = {
  operatorApprovals: typeof operatorApprovals;
  githubActionProposals: typeof githubActionProposals;
};

export type ConnectorInboxConnection = PgliteDatabase<ConnectorInboxSchema>;

export interface ConnectorInboxHarness {
  db: ConnectorInboxConnection;
  close(): Promise<void>;
}

/** Boot a throwaway `@electric-sql/pglite` instance with exactly the connector-Inbox tables. */
export async function createConnectorInboxHarness(): Promise<ConnectorInboxHarness> {
  const client = new PGlite({ extensions: { pgcrypto } });
  await client.waitReady;
  await client.exec(SCHEMA_SQL);

  const db = drizzle(client, { schema: { operatorApprovals, githubActionProposals } });

  return {
    db,
    async close() {
      await client.close();
    },
  };
}

/**
 * Seed one `operator.approvals` row. Defaults to the pre-#2723 MISROUTE: a
 * pending github connector proposal owned by the connector owner but stored
 * under the node operator — the exact shape the backlog re-address and the
 * owner-only read/decide must handle.
 */
export async function seedApproval(
  db: ConnectorInboxConnection,
  overrides: Partial<typeof operatorApprovals.$inferInsert> & { proposalId: string },
): Promise<void> {
  await db.insert(operatorApprovals).values({
    operatorDid: OPERATOR_DID,
    source: 'github',
    kind: 'github:mutate',
    summary: 'close a/b#1',
    detail: githubProposalDetail(CONNECTOR_OWNER_DID),
    status: 'pending',
    ...overrides,
  });
}

/** Seed the `github.action_proposals` ledger row an approval of `proposalId` flips. */
export async function seedLedgerRow(db: ConnectorInboxConnection, id: string, ownerDid: string): Promise<void> {
  await db.insert(githubActionProposals).values({
    id,
    ownerDid,
    scope: 'github:write',
    tool: 'github_update_issue',
    riskTier: 'mutate',
    target: 'a/b#1',
    argsSummary: 'close a/b#1',
    status: 'pending',
  });
}

/**
 * Lazily forward every property access to whatever `getDb()` returns at call
 * time. `vi.mock('@/src/db')` factories run before `beforeAll` has booted the
 * engine, so the mocked `db` export must resolve the real one on each use.
 */
export function forwardingDb(getDb: () => unknown): unknown {
  return new Proxy({}, {
    get: (_target, prop) => {
      const value = (getDb() as Record<string, unknown>)[prop as string];
      return typeof value === 'function' ? value.bind(getDb()) : value;
    },
  });
}

/**
 * Boot the engine once per suite and publish its `db` on `holder` (the object
 * the suite's `vi.mock('@/src/db')` forwards to). Returns an accessor for the
 * suite's own queries.
 */
export function installConnectorInboxHarness(holder: { db: unknown }): { readonly db: ConnectorInboxConnection } {
  let harness: ConnectorInboxHarness;
  beforeAll(async () => {
    harness = await createConnectorInboxHarness();
    holder.db = harness.db;
  });
  afterAll(async () => {
    await harness.close();
  });
  return {
    get db() {
      return harness.db;
    },
  };
}
