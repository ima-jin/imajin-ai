/**
 * `getTaxRemittanceOwed` (#2419, #2439): the remittance-owed report shows
 * the registration number next to what's owed. `@/src/db` is mocked with a
 * recording query-builder chain so the test asserts what is selected,
 * grouped, and mapped — the SQL itself is exercised by the DB-backed suite.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  selectedFields: undefined as Record<string, unknown> | undefined,
  groupByArgs: [] as unknown[],
  rows: [] as Array<Record<string, unknown>>,
}));

function groupBy(...args: unknown[]) {
  state.groupByArgs = args;
  return Promise.resolve(state.rows);
}
function where() {
  return { groupBy };
}
function from() {
  return { where };
}
function select(fields: Record<string, unknown>) {
  state.selectedFields = fields;
  return { from };
}

vi.mock('@/src/db', () => ({
  db: { select },
  transactions: { toDid: 'to_did', status: 'status', metadata: 'metadata', amount: 'amount' },
}));

import { getTaxRemittanceOwed } from '../tax-remittance';

beforeEach(() => {
  state.selectedFields = undefined;
  state.groupByArgs = [];
  state.rows = [];
});

describe('getTaxRemittanceOwed', () => {
  it('selects the registration number alongside jurisdiction, kind and the summed amount', async () => {
    await getTaxRemittanceOwed('did:imajin:seller');
    expect(Object.keys(state.selectedFields ?? {})).toEqual(['jurisdiction', 'kind', 'registrationNumber', 'amount']);
  });

  it('groups by jurisdiction, kind and registration number', async () => {
    await getTaxRemittanceOwed('did:imajin:seller');
    expect(state.groupByArgs).toHaveLength(3);
  });

  it('returns each owed line with its registration number and a numeric amount', async () => {
    state.rows = [
      { jurisdiction: 'CA-ON', kind: 'GST/HST', registrationNumber: '123456789RT0001', amount: '13.00' },
      { jurisdiction: 'CA-BC', kind: 'PST', registrationNumber: '12345678', amount: '7.5' },
    ];
    expect(await getTaxRemittanceOwed('did:imajin:seller')).toEqual([
      { jurisdiction: 'CA-ON', kind: 'GST/HST', registrationNumber: '123456789RT0001', amount: 13 },
      { jurisdiction: 'CA-BC', kind: 'PST', registrationNumber: '12345678', amount: 7.5 },
    ]);
  });

  it('reports registrationNumber: null for credits settled before it was persisted', async () => {
    state.rows = [{ jurisdiction: 'CA-ON', kind: 'GST/HST', registrationNumber: null, amount: '13' }];
    expect(await getTaxRemittanceOwed('did:imajin:seller')).toEqual([
      { jurisdiction: 'CA-ON', kind: 'GST/HST', registrationNumber: null, amount: 13 },
    ]);
  });

  it('returns an empty list when nothing is owed', async () => {
    expect(await getTaxRemittanceOwed('did:imajin:seller')).toEqual([]);
  });
});
