import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { usageIncurred } from '../usage';

describe('incurred pricing provenance (#2972)', () => {
  it('adds only nullable pricing JSONB and keeps old writers/rollback valid', () => {
    const column = getTableColumns(usageIncurred).pricing;
    expect(column.dataType).toBe('json');
    expect(column.notNull).toBe(false);
    const migration = readFileSync(resolve(__dirname, '../../../../../../migrations/archive/pre-kernel-baseline/0214_usage_incurred_pricing.sql'), 'utf8');
    expect(migration).toContain('ALTER TABLE usage.incurred ADD COLUMN IF NOT EXISTS pricing JSONB');
    expect(migration).not.toMatch(/usage\.billed|DROP|RENAME/);
  });
});
