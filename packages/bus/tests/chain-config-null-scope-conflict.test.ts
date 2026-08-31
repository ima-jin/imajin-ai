import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(__dirname, '../../../migrations');

function readMigration(filename: string): string {
  return readFileSync(resolve(migrationsDir, filename), 'utf8');
}

describe('bus_chain_configs NULL-scope duplicate-row fix (#1869)', () => {
  describe('migration guards', () => {
    it('preserves the original schema as the bug precondition', () => {
      const sql = readMigration('0037_bus_chain_configs.sql');

      expect(sql).toMatch(/UNIQUE\s*\(event_type,\s*scope\)/);
      expect(sql).not.toMatch(/NULLS NOT DISTINCT/);
    });

    it('captures the NULL-scope upsert in 0096 that produced the duplicate', () => {
      const sql = readMigration('0096_attestation_notify_chain.sql');

      expect(sql).toMatch(
        /VALUES\s*\(\s*'attestation\.created',\s*NULL,[\s\S]*ON CONFLICT \(event_type, scope\) DO UPDATE/
      );
    });

    it('deduplicates every NULL-scope event type and keeps only the newest row', () => {
      const sql = readMigration('0098_reconcile_bus_chain_configs.sql');

      expect(sql).toMatch(/DELETE FROM kernel\.bus_chain_configs/);
      expect(sql).toMatch(/PARTITION BY event_type/);
      expect(sql).toMatch(/ORDER BY updated_at DESC, created_at DESC, id DESC/);
      expect(sql).toMatch(/WHERE scope IS NULL/);
      expect(sql).toMatch(/WHERE rn > 1/);
    });

    it('makes NULL scope participate in conflict detection', () => {
      const sql = readMigration('0098_reconcile_bus_chain_configs.sql');

      expect(sql).toContain('ADD CONSTRAINT uniq_bus_chain_configs_event_type_scope');
      expect(sql).toMatch(/UNIQUE NULLS NOT DISTINCT \(event_type, scope\)/);
    });

    it('re-upserts attestation.created after dedupe with emit and attestation-notify', () => {
      const sql = readMigration('0098_reconcile_bus_chain_configs.sql');
      const upsertStart = sql.lastIndexOf(`'attestation.created'`);
      const upsert = sql.slice(upsertStart, upsertStart + 400);

      expect(upsertStart).toBeGreaterThan(-1);
      expect(upsert).toContain('attestation-notify');
      expect(upsert).toContain('ON CONFLICT (event_type, scope) DO UPDATE');
    });
  });

  describe('NULL-scope conflict semantics', () => {
    type Row = { eventType: string; scope: string | null; reactors: string[] };

    function upsert(
      table: Row[],
      nullsNotDistinct: boolean,
      row: Row
    ): 'inserted' | 'updated' {
      const conflict = table.find((existing) => {
        if (existing.eventType !== row.eventType) return false;
        if (existing.scope === null && row.scope === null) return nullsNotDistinct;
        return existing.scope === row.scope;
      });

      if (conflict) {
        conflict.reactors = row.reactors;
        return 'updated';
      }

      table.push({ ...row });
      return 'inserted';
    }

    it('plain UNIQUE permits duplicate NULL-scope rows', () => {
      const rows: Row[] = [
        { eventType: 'attestation.created', scope: null, reactors: ['emit'] },
      ];

      const result = upsert(rows, false, {
        eventType: 'attestation.created',
        scope: null,
        reactors: ['emit', 'attestation-notify'],
      });

      expect(result).toBe('inserted');
      expect(rows).toHaveLength(2);
    });

    it('UNIQUE NULLS NOT DISTINCT updates the existing NULL-scope row', () => {
      const rows: Row[] = [
        { eventType: 'attestation.created', scope: null, reactors: ['emit'] },
      ];

      const result = upsert(rows, true, {
        eventType: 'attestation.created',
        scope: null,
        reactors: ['emit', 'attestation-notify'],
      });

      expect(result).toBe('updated');
      expect(rows).toHaveLength(1);
      expect(rows[0]?.reactors).toEqual(['emit', 'attestation-notify']);
    });

    it('still permits distinct event types with NULL scope', () => {
      const rows: Row[] = [
        { eventType: 'attestation.created', scope: null, reactors: ['emit'] },
      ];

      const result = upsert(rows, true, {
        eventType: 'identity.created',
        scope: null,
        reactors: ['attestation'],
      });

      expect(result).toBe('inserted');
      expect(rows).toHaveLength(2);
    });

    it('still permits a scoped row for the same event type', () => {
      const rows: Row[] = [
        { eventType: 'attestation.created', scope: null, reactors: ['emit'] },
      ];

      const result = upsert(rows, true, {
        eventType: 'attestation.created',
        scope: 'scoped-app',
        reactors: ['attestation'],
      });

      expect(result).toBe('inserted');
      expect(rows).toHaveLength(2);
    });
  });
});
