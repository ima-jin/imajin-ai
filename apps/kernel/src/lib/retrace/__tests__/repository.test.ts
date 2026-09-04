/**
 * Unit tests for the retrace storage layer (#1962): the documented
 * parent-link resolution rule per artifact kind (linear + branching cases),
 * terminal reasons, and signature verification. Exercised through
 * `createDefaultRepository().fetch()` against a predicate-filtered fake
 * `@/src/db`, mirroring the mocking convention already used by
 * `agent-provisioner.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;
interface DescSpec { __desc: string }

function cols(names: string[]): Record<string, string> {
  return Object.fromEntries(names.map((n) => [n, n]));
}

const { ATTESTATIONS, AGENT_PROVISIONS, AUDIT_LOG, IDENTITIES, stores, verifySyncMock } = vi.hoisted(() => ({
  ATTESTATIONS: cols(['id', 'issuerDid', 'subjectDid', 'type', 'contextId', 'contextType', 'payload', 'signature', 'prevEventRef', 'delegationGrantId', 'delegatorDid', 'disclosureScope', 'issuedAt', 'revokedAt']),
  AGENT_PROVISIONS: cols(['id', 'servingDid', 'delegatorDid', 'agentDid', 'grantId', 'createdAt']),
  AUDIT_LOG: cols(['id', 'eventType', 'scope', 'issuer', 'subject', 'correlationId', 'payload', 'createdAt']),
  IDENTITIES: cols(['id', 'publicKey']),
  stores: {
    attestations: [] as Row[],
    agentProvisions: [] as Row[],
    auditLog: [] as Row[],
    identities: [] as Row[],
  },
  verifySyncMock: vi.fn(),
}));

function storeFor(table: unknown): Row[] {
  if (table === ATTESTATIONS) return stores.attestations;
  if (table === AGENT_PROVISIONS) return stores.agentProvisions;
  if (table === AUDIT_LOG) return stores.auditLog;
  if (table === IDENTITIES) return stores.identities;
  return [];
}

function project(rows: Row[], projection?: Record<string, string>): Row[] {
  if (!projection) return rows.map((r) => ({ ...r }));
  return rows.map((r) => Object.fromEntries(Object.entries(projection).map(([outKey, col]) => [outKey, r[col]])));
}

function sortByDesc(rows: Row[], spec?: DescSpec): Row[] {
  if (!spec) return rows;
  const { __desc: column } = spec;
  return [...rows].sort((a, b) => new Date(b[column] as string).getTime() - new Date(a[column] as string).getTime());
}

/**
 * Keeps full rows through `.orderBy()` and only applies the select
 * projection when the query is finally consumed (`.then()`/`.limit()`) —
 * real SQL can `ORDER BY` a column that isn't in the `SELECT` list, so the
 * fake must defer projection the same way rather than stripping the sort
 * column out before `.orderBy()` runs.
 */
function queryable(rows: Row[], projection?: Record<string, string>) {
  const output = () => project(rows, projection);
  return {
    then: (...args: Parameters<Promise<Row[]>['then']>) => Promise.resolve(output()).then(...args),
    catch: (...args: Parameters<Promise<Row[]>['catch']>) => Promise.resolve(output()).catch(...args),
    finally: (...args: Parameters<Promise<Row[]>['finally']>) => Promise.resolve(output()).finally(...args),
    limit: (n: number) => Promise.resolve(output().slice(0, n)),
    orderBy: (spec?: DescSpec) => queryable(sortByDesc(rows, spec), projection),
  };
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const eq = (column: string, value: unknown): Predicate => (row) => row[column] === value;
  const and = (...preds: Predicate[]): Predicate => (row) => preds.every((p) => p(row));
  const isNull = (column: string): Predicate => (row) => row[column] === null || row[column] === undefined;
  const lt = (column: string, value: unknown): Predicate => (row) => new Date(row[column] as string).getTime() < new Date(value as string).getTime();
  const desc = (column: string): DescSpec => ({ __desc: column });
  return { ...actual, eq, and, isNull, lt, desc };
});

vi.mock('@/src/db', () => ({
  db: {
    select: (projection?: Record<string, string>) => ({
      from: (table: unknown) => ({
        where: (pred: Predicate) => queryable(storeFor(table).filter(pred), projection),
      }),
    }),
  },
  attestations: ATTESTATIONS,
  agentProvisions: AGENT_PROVISIONS,
  auditLog: AUDIT_LOG,
  identities: IDENTITIES,
}));

vi.mock('@imajin/auth', () => ({
  canonicalize: (obj: unknown) => JSON.stringify(obj),
  verifySync: verifySyncMock,
  isDisclosureScope: (v: unknown) => ['parties', 'connections', 'network', 'public'].includes(v as string),
  capabilityForDelegatedAttestationType: (type: string) => (type === 'consent_given' ? 'messages:write' : null),
}));

vi.mock('@imajin/trust-graph', () => ({ trustRadius: vi.fn() }));

import { identifyArtifactKind, createDefaultRepository } from '../repository';

function attestationRow(overrides: Row = {}): Row {
  return {
    id: 'att_1', issuerDid: 'did:imajin:actor', subjectDid: 'did:imajin:subject', type: 'consent_given',
    contextId: null, contextType: null, payload: null, signature: 'sig-hex', prevEventRef: null,
    delegationGrantId: null, delegatorDid: null, disclosureScope: 'parties',
    issuedAt: new Date('2026-01-01T00:00:00.000Z'), revokedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  stores.attestations = [];
  stores.agentProvisions = [];
  stores.auditLog = [];
  stores.identities = [];
  verifySyncMock.mockReturnValue(true);
});

describe('identifyArtifactKind', () => {
  it('infers attestation from the att_ prefix', () => {
    expect(identifyArtifactKind('att_123')).toBe('attestation');
  });
  it('infers agent_provision from the prov_ prefix', () => {
    expect(identifyArtifactKind('prov_123')).toBe('agent_provision');
  });
  it('falls back to bus_event for an opaque id', () => {
    expect(identifyArtifactKind('a1b2c3-uuid')).toBe('bus_event');
  });
  it('lets an explicit kind override the inferred one', () => {
    expect(identifyArtifactKind('att_123', 'bus_event')).toBe('bus_event');
  });
});

describe('repository — attestation parent-link rule', () => {
  it('prefers prevEventRef when present', async () => {
    stores.identities = [{ id: 'did:imajin:actor', publicKey: 'pub' }];
    stores.attestations = [attestationRow({ prevEventRef: 'att_parent' })];

    const hop = await createDefaultRepository().fetch({ kind: 'attestation', id: 'att_1' });

    expect(hop?.parent).toEqual({ kind: 'attestation', id: 'att_parent' });
    expect(hop?.terminalReason).toBeNull();
  });

  it('falls back to the nearest earlier turn in the same session for agent.turn.usage rows (branching)', async () => {
    stores.identities = [{ id: 'did:imajin:actor', publicKey: 'pub' }];
    stores.attestations = [
      attestationRow({ id: 'att_current', type: 'agent.turn.usage', payload: { session: 's1' }, issuedAt: new Date('2026-01-01T00:03:00.000Z') }),
      attestationRow({ id: 'att_far', type: 'agent.turn.usage', payload: { session: 's1' }, issuedAt: new Date('2026-01-01T00:01:00.000Z') }),
      attestationRow({ id: 'att_near', type: 'agent.turn.usage', payload: { session: 's1' }, issuedAt: new Date('2026-01-01T00:02:00.000Z') }),
      attestationRow({ id: 'att_other_session', type: 'agent.turn.usage', payload: { session: 's2' }, issuedAt: new Date('2026-01-01T00:02:30.000Z') }),
    ];

    const hop = await createDefaultRepository().fetch({ kind: 'attestation', id: 'att_current' });

    // Two earlier same-session candidates (att_far, att_near) — the rule picks the nearest, not the oldest.
    expect(hop?.parent).toEqual({ kind: 'attestation', id: 'att_near' });
  });

  it('falls back to the context event when there is no prevEventRef or session predecessor', async () => {
    stores.identities = [{ id: 'did:imajin:actor', publicKey: 'pub' }];
    stores.attestations = [attestationRow({ contextType: 'event', contextId: 'evt_1' })];

    const hop = await createDefaultRepository().fetch({ kind: 'attestation', id: 'att_1' });

    expect(hop?.parent).toEqual({ kind: 'bus_event', id: 'evt_1' });
  });

  it('is terminal when no parent link resolves', async () => {
    stores.identities = [{ id: 'did:imajin:actor', publicKey: 'pub' }];
    stores.attestations = [attestationRow()];

    const hop = await createDefaultRepository().fetch({ kind: 'attestation', id: 'att_1' });

    expect(hop?.parent).toBeNull();
    expect(hop?.terminalReason).toBeTruthy();
  });

  it('returns null for an unknown attestation id', async () => {
    const hop = await createDefaultRepository().fetch({ kind: 'attestation', id: 'att_missing' });
    expect(hop).toBeNull();
  });

  it.each([
    ['unsigned', { signature: null }, undefined],
    ['invalid (missing issuer identity)', {}, undefined],
    ['verified', {}, true],
    ['invalid (bad signature)', {}, false],
  ] as const)('resolves signature status: %s', async (label, overrides, verifyResult) => {
    if (label !== 'invalid (missing issuer identity)') {
      stores.identities = [{ id: 'did:imajin:actor', publicKey: 'pub' }];
    }
    if (verifyResult !== undefined) verifySyncMock.mockReturnValue(verifyResult);
    stores.attestations = [attestationRow(overrides)];

    const hop = await createDefaultRepository().fetch({ kind: 'attestation', id: 'att_1' });

    const expected = label.startsWith('unsigned') ? 'unsigned' : label.startsWith('verified') ? 'verified' : 'invalid';
    expect(hop?.signature).toBe(expected);
  });

  it('resolves a grant + capability when delegationGrantId is present', async () => {
    stores.identities = [{ id: 'did:imajin:actor', publicKey: 'pub' }];
    stores.attestations = [attestationRow({ delegationGrantId: 'grant_1', type: 'consent_given' })];

    const hop = await createDefaultRepository().fetch({ kind: 'attestation', id: 'att_1' });

    expect(hop?.grant).toEqual({ grantId: 'grant_1', capability: 'messages:write' });
  });
});

describe('repository — agent_provision hops', () => {
  it('is always terminal, with actor/audience derived from the provision row', async () => {
    stores.agentProvisions = [{ id: 'prov_1', servingDid: 'did:imajin:owner', delegatorDid: 'did:imajin:owner', agentDid: 'did:imajin:agent', grantId: 'grant_9', createdAt: new Date('2026-01-01T00:00:00.000Z') }];

    const hop = await createDefaultRepository().fetch({ kind: 'agent_provision', id: 'prov_1' });

    expect(hop?.parent).toBeNull();
    expect(hop?.terminalReason).toBeTruthy();
    expect(hop?.actorDid).toBe('did:imajin:owner');
    expect(hop?.grant).toEqual({ grantId: 'grant_9' });
    expect(hop?.signature).toBe('unsigned');
  });

  it('returns null for an unknown provision id', async () => {
    const hop = await createDefaultRepository().fetch({ kind: 'agent_provision', id: 'prov_missing' });
    expect(hop).toBeNull();
  });
});

describe('repository — bus_event parent-link rule', () => {
  function eventRow(overrides: Row = {}): Row {
    return { id: 'evt_1', eventType: 'attestation.created', scope: 'auth', issuer: 'did:imajin:actor', subject: 'did:imajin:subject', correlationId: null, payload: null, createdAt: new Date('2026-01-01T00:00:00.000Z'), ...overrides };
  }

  it('prefers a payload-linked attestationId', async () => {
    stores.auditLog = [eventRow({ payload: { attestationId: 'att_x' } })];
    const hop = await createDefaultRepository().fetch({ kind: 'bus_event', id: 'evt_1' });
    expect(hop?.parent).toEqual({ kind: 'attestation', id: 'att_x' });
  });

  it('falls back to a payload-linked provisionId', async () => {
    stores.auditLog = [eventRow({ payload: { provisionId: 'prov_x' } })];
    const hop = await createDefaultRepository().fetch({ kind: 'bus_event', id: 'evt_1' });
    expect(hop?.parent).toEqual({ kind: 'agent_provision', id: 'prov_x' });
  });

  it('falls back to the nearest earlier event sharing the same correlationId (branching)', async () => {
    stores.auditLog = [
      eventRow({ id: 'evt_current', correlationId: 'corr_1', createdAt: new Date('2026-01-01T00:03:00.000Z') }),
      eventRow({ id: 'evt_far', correlationId: 'corr_1', createdAt: new Date('2026-01-01T00:01:00.000Z') }),
      eventRow({ id: 'evt_near', correlationId: 'corr_1', createdAt: new Date('2026-01-01T00:02:00.000Z') }),
      eventRow({ id: 'evt_other_corr', correlationId: 'corr_2', createdAt: new Date('2026-01-01T00:02:30.000Z') }),
    ];

    const hop = await createDefaultRepository().fetch({ kind: 'bus_event', id: 'evt_current' });

    expect(hop?.parent).toEqual({ kind: 'bus_event', id: 'evt_near' });
  });

  it('is terminal with no payload link and no correlated predecessor', async () => {
    stores.auditLog = [eventRow()];
    const hop = await createDefaultRepository().fetch({ kind: 'bus_event', id: 'evt_1' });
    expect(hop?.parent).toBeNull();
    expect(hop?.terminalReason).toBeTruthy();
  });

  it('returns null for an unknown bus_event id', async () => {
    const hop = await createDefaultRepository().fetch({ kind: 'bus_event', id: 'evt_missing' });
    expect(hop).toBeNull();
  });
});
