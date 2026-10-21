import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL(
  '../../../../../../migrations/0218_connection_requested_notify_chain.sql', import.meta.url,
), 'utf8');
const requestedChain = [
  { type: 'notify', config: { scope: 'connection:request-received' }, enabled: true },
];

describe('0218 direct connection request chain (#3013)', () => {
  it('seeds and replays a single notify-only default without altering invited or scoped flows', async () => {
    const db = new PGlite();
    try {
      await db.exec(`CREATE SCHEMA kernel;
        CREATE TABLE kernel.bus_chain_configs (
          id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
          event_type text NOT NULL, scope text, reactors jsonb NOT NULL,
          enabled boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE NULLS NOT DISTINCT (event_type, scope)
        );
        INSERT INTO kernel.bus_chain_configs (event_type, scope, reactors) VALUES
          ('connection.invited', NULL, '[{"type":"attestation","config":{"attestationType":"connection.invited"},"enabled":true}]'),
          ('connection.requested', 'custom-scope', '[{"type":"emit","config":{},"enabled":true}]');`);
      const untouched = await db.query(`SELECT * FROM kernel.bus_chain_configs ORDER BY event_type, scope`);
      await db.transaction(tx => tx.exec(migration));
      const first = await db.query(`SELECT id, reactors, enabled FROM kernel.bus_chain_configs
        WHERE event_type = 'connection.requested' AND scope IS NULL`);
      expect(first.rows).toEqual([{ id: expect.any(String), reactors: requestedChain, enabled: true }]);
      await db.transaction(tx => tx.exec(migration));
      expect(await db.query(`SELECT id, reactors, enabled FROM kernel.bus_chain_configs
        WHERE event_type = 'connection.requested' AND scope IS NULL`)).toEqual(first);
      expect(await db.query(`SELECT * FROM kernel.bus_chain_configs
        WHERE event_type = 'connection.invited' OR scope = 'custom-scope' ORDER BY event_type, scope`)).toEqual(untouched);
      // A pre-existing row must not shadow the new delivery chain on deployed nodes.
      await db.exec(`UPDATE kernel.bus_chain_configs SET reactors = '[]', enabled = false
        WHERE event_type = 'connection.requested' AND scope IS NULL`);
      await db.transaction(tx => tx.exec(migration));
      expect(await db.query(`SELECT id, reactors, enabled FROM kernel.bus_chain_configs
        WHERE event_type = 'connection.requested' AND scope IS NULL`)).toEqual(first);
    } finally {
      await db.close();
    }
  });
});
