import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, it, expect, vi } from 'vitest';

vi.mock('@imajin/db', () => ({ getClient: () => () => Promise.resolve([]) }));

import { getChainConfig } from '../../../../../../../packages/bus/src/config';

function migration(name: string): string {
  return readFileSync(new URL(`../../../../../../../migrations/${name}`, import.meta.url), 'utf8');
}

describe('Reach chain migration parity (#2588)', () => {
  it('idempotently seeds default and replaces stale agent overrides with the code-default reactors', async () => {
    const db = new PGlite();
    try {
      await db.exec(migration('0037_bus_chain_configs.sql'));
      await db.exec(migration('0098_reconcile_bus_chain_configs.sql'));
      await db.exec(`
        INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors, enabled)
        VALUES
          ('agent.reach.delivered', NULL, '[{"type":"attestation"}]', false),
          ('agent.reach.delivered', 'agent', '[{"type":"attestation"}]', false),
          ('unrelated.event', 'agent', '[]', false);
      `);
      const sql = migration('0193_seed_agent_reach_delivered_chain.sql');
      await db.exec(sql);
      await db.exec(sql);
      const { rows } = await db.query<{ scope: string | null; reactors: unknown; enabled: boolean }>(
        "SELECT scope, reactors, enabled FROM kernel.bus_chain_configs WHERE event_type = 'agent.reach.delivered'",
      );
      const fallback = await getChainConfig('agent.reach.delivered', 'agent');
      expect(fallback.source).toBe('defaults');
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.scope)).toContain(null);
      expect(rows.map((row) => row.scope)).toContain('agent');
      for (const row of rows) {
        expect(row.reactors).toEqual(fallback.reactors);
        expect(row.enabled).toBe(true);
      }
      const unrelated = await db.query("SELECT enabled FROM kernel.bus_chain_configs WHERE event_type = 'unrelated.event'");
      expect(unrelated.rows).toEqual([{ enabled: false }]);
    } finally {
      await db.close();
    }
  }, 20_000);
});
