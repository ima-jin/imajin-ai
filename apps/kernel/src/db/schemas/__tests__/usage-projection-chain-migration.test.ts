import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL(
  '../../../../../../migrations/0231_usage_projection_chain.sql', import.meta.url,
), 'utf8');

describe('usage projection chain migration', () => {
  it('upserts the seeded NULL-scope default twice, preserving other scopes and events', async () => {
    const pg = new PGlite();
    try {
      const baseline = readFileSync(new URL('../../../../../../migrations/0001_kernel_baseline.sql', import.meta.url), 'utf8');
      const constraint = baseline.match(/ADD CONSTRAINT uniq_bus_chain_configs_event_type_scope UNIQUE NULLS NOT DISTINCT \(event_type, scope\);/)?.[0];
      expect(constraint).toBeDefined();
      await pg.exec(`CREATE SCHEMA kernel;
        CREATE TABLE kernel.bus_chain_configs (
          event_type text NOT NULL, scope text, reactors jsonb NOT NULL,
          enabled boolean NOT NULL DEFAULT true, updated_at timestamptz DEFAULT now()
        );
        ALTER TABLE kernel.bus_chain_configs ${constraint}
        INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors) VALUES
          ('usage.incurred', NULL, '[{"type":"attestation"},{"type":"emit"}]'),
          ('usage.incurred', 'custom', '[]'),
          ('usage.rollup', NULL, '[]');`);
      await pg.exec(migration);
      const first = await pg.query('SELECT event_type, scope, reactors, enabled FROM kernel.bus_chain_configs ORDER BY event_type, scope NULLS FIRST');
      await pg.exec(migration);
      expect(await pg.query('SELECT event_type, scope, reactors, enabled FROM kernel.bus_chain_configs ORDER BY event_type, scope NULLS FIRST')).toEqual(first);
      expect(first.rows).toEqual([
        { event_type: 'usage.incurred', scope: null, enabled: true, reactors: [
          { type: 'attestation', config: { attestationType: 'usage.incurred' }, enabled: true },
          { type: 'emit', config: {}, enabled: true },
          { type: 'usage-projection', config: {}, enabled: true },
        ] },
        { event_type: 'usage.incurred', scope: 'custom', enabled: true, reactors: [] },
        { event_type: 'usage.rollup', scope: null, enabled: true, reactors: [] },
      ]);
      // Fresh installations and an accidentally disabled default are covered too.
      await pg.exec('ALTER TABLE kernel.bus_chain_configs RENAME TO previous_configs;');
      await pg.exec(`CREATE TABLE kernel.bus_chain_configs (LIKE kernel.previous_configs INCLUDING ALL);`);
      await pg.exec(migration);
      await pg.exec(`UPDATE kernel.bus_chain_configs SET enabled = false;`);
      await pg.exec(migration);
      expect((await pg.query('SELECT reactors, enabled FROM kernel.bus_chain_configs')).rows)
        .toEqual([{ reactors: first.rows[0].reactors, enabled: true }]);
    } finally {
      await pg.close();
    }
  }, 30_000);
});
