import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake postgres.js tagged-template client: records each query's skeleton +
// interpolated values so we can assert what SQL the reactor issues, no DB needed.
const { calls, fakeSql } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    return Promise.resolve([]);
  };
  return { calls, fakeSql };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import { auditLogReactor } from '../src/reactors/audit-log';
import type { BusEvent } from '../src/types';

const ISSUER = 'did:imajin:alice';
const SUBJECT = 'did:imajin:bob';
const CORRELATION_ID = 'corr_001';

// INSERT column order: id, event_type, scope, issuer, subject,
// correlation_id, payload(json string), reactor_config(json string).
const V = {
  id: 0,
  eventType: 1,
  scope: 2,
  issuer: 3,
  subject: 4,
  correlationId: 5,
  payload: 6,
  reactorConfig: 7,
} as const;

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    type: 'listing.created',
    issuer: ISSUER,
    subject: SUBJECT,
    scope: 'market',
    correlationId: CORRELATION_ID,
    payload: { title: 'Widget', price: 100, currency: 'CAD' },
    ...overrides,
  };
}

describe('auditLogReactor (#1140)', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('writes one audit_log row capturing the whole payload by default', async () => {
    await auditLogReactor(makeEvent(), {});

    expect(calls).toHaveLength(1);
    const { text, values } = calls[0];
    expect(text).toContain('INSERT INTO kernel.audit_log');
    expect(values[V.eventType]).toBe('listing.created');
    expect(values[V.scope]).toBe('market');
    expect(values[V.issuer]).toBe(ISSUER);
    expect(values[V.subject]).toBe(SUBJECT);
    expect(values[V.correlationId]).toBe(CORRELATION_ID);
    expect(JSON.parse(values[V.payload] as string)).toEqual({
      title: 'Widget',
      price: 100,
      currency: 'CAD',
    });
  });

  it('projects only configured fields when config.fields is set', async () => {
    await auditLogReactor(makeEvent(), { fields: ['title', 'missing'] });

    expect(calls).toHaveLength(1);
    // Only present, configured keys survive the projection.
    expect(JSON.parse(calls[0].values[V.payload] as string)).toEqual({ title: 'Widget' });
  });

  it('stores a null payload when config.payload === false', async () => {
    await auditLogReactor(makeEvent(), { payload: false });

    expect(calls).toHaveLength(1);
    expect(calls[0].values[V.payload]).toBeNull();
  });

  it('persists the reactor config for provenance', async () => {
    const config = { fields: ['title'], note: 'trail' };
    await auditLogReactor(makeEvent(), config);

    expect(JSON.parse(calls[0].values[V.reactorConfig] as string)).toEqual(config);
  });

  it('still writes a row (correlation_id null) when the event has no correlationId', async () => {
    await auditLogReactor(makeEvent({ correlationId: undefined }), {});

    expect(calls).toHaveLength(1);
    expect(calls[0].values[V.correlationId]).toBeNull();
  });

  it('records an empty payload when the event has no payload', async () => {
    await auditLogReactor(makeEvent({ payload: undefined }), {});

    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].values[V.payload] as string)).toEqual({});
  });

  it('skips all DB work in preview mode (payload.preview === true)', async () => {
    await auditLogReactor(makeEvent({ payload: { preview: true, title: 'Widget' } }), {});

    expect(calls).toHaveLength(0);
  });
});
