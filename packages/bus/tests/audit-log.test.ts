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

// #2263 audit — follow-up to PR #2255/#2251. Confirms the durable
// kernel.audit_log record for every agent.reach exchange (answered or
// denied) discloses only the disclosure-safe key set already documented at
// packages/bus/src/types.ts (agent.reach.answered / agent.reach.denied) and
// packages/bus/src/config.ts's DEFAULTS entries (kept in sync with
// migration 0151). Pinned as an exact key-set assertion — not
// `objectContaining` — so widening the config's `fields` allowlist (or
// flipping it to the reactor's "store the whole payload" default) is a
// visible, deliberate diff here rather than a silent disclosure regression.
//
// Feeds the reactor a payload shaped like the real bus event PLUS fields
// that must never reach this table even if a future change accidentally
// widened the published event itself (transcript bytes, the requester's
// raw signature, the boolean-gate `arg`/`predicate` internals, free-text
// `selfDescription`) — proving the config-level allowlist actively strips
// them, not merely that today's event happens to omit them.
describe('agent.reach disclosure allowlist (#2263 audit — no signatures, no gate internals, no message bodies)', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  const NEVER_DISCLOSED = {
    transcriptHash: 'sha256:should-never-reach-audit-log',
    requesterSignature: 'ed25519:should-never-reach-audit-log',
    signatureVerified: true,
    arg: 'business_development',
    predicate: 'contains',
    selfDescription: 'free-text self-description should never reach audit-log',
    onBehalfOfPlatform: 'meta-muse',
  };

  it('agent.reach.answered: audit_log row is exactly {requesterDid, principalDid, onBehalfOfStubDid, purpose, field, answer, grantId}', async () => {
    const event = makeEvent({
      type: 'agent.reach.answered',
      scope: 'agent',
      payload: {
        requesterDid: 'did:imajin:muse-agent',
        principalDid: 'did:imajin:ryan',
        onBehalfOfStubDid: 'did:imajin:alice-stub',
        purpose: 'agent.reach',
        field: 'contact_topics',
        answer: true,
        grantId: 'grant_1',
        context_id: 'did:imajin:muse-agent',
        context_type: 'agent.reach',
        ...NEVER_DISCLOSED,
      },
    });
    // Same allowlist as packages/bus/src/config.ts DEFAULTS['agent.reach.answered']
    // and migration 0151's kernel.bus_chain_configs row.
    const config = {
      fields: ['requesterDid', 'principalDid', 'onBehalfOfStubDid', 'purpose', 'field', 'answer', 'grantId'],
    };

    await auditLogReactor(event, config);

    expect(calls).toHaveLength(1);
    const projected = JSON.parse(calls[0].values[V.payload] as string);
    expect(projected).toEqual({
      requesterDid: 'did:imajin:muse-agent',
      principalDid: 'did:imajin:ryan',
      onBehalfOfStubDid: 'did:imajin:alice-stub',
      purpose: 'agent.reach',
      field: 'contact_topics',
      answer: true,
      grantId: 'grant_1',
    });
    for (const key of Object.keys(NEVER_DISCLOSED)) {
      expect(projected).not.toHaveProperty(key);
    }
  });

  it('agent.reach.denied: audit_log row is exactly {requesterDid, principalDid, reason}', async () => {
    const event = makeEvent({
      type: 'agent.reach.denied',
      scope: 'agent',
      payload: {
        requesterDid: 'did:imajin:muse-agent',
        principalDid: 'did:imajin:ryan',
        reason: 'unauthorized',
        context_id: 'did:imajin:muse-agent',
        context_type: 'agent.reach',
        ...NEVER_DISCLOSED,
      },
    });
    // Same allowlist as packages/bus/src/config.ts DEFAULTS['agent.reach.denied']
    // and migration 0151's kernel.bus_chain_configs row.
    const config = { fields: ['requesterDid', 'principalDid', 'reason'] };

    await auditLogReactor(event, config);

    expect(calls).toHaveLength(1);
    const projected = JSON.parse(calls[0].values[V.payload] as string);
    expect(projected).toEqual({
      requesterDid: 'did:imajin:muse-agent',
      principalDid: 'did:imajin:ryan',
      reason: 'unauthorized',
    });
    for (const key of Object.keys(NEVER_DISCLOSED)) {
      expect(projected).not.toHaveProperty(key);
    }
  });
});
