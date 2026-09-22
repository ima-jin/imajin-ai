/**
 * Unit tests for the per-principal agent-reach gate (#2251).
 *
 * Exercises the orchestration in isolation: `broker()`, `introspectGrant()`,
 * `verifySignature()`, and the foreign-principal-stub primitive are mocked
 * so this file tests decision logic (fail-closed on every denial path,
 * revocation propagation, attestation + bus-event emission on success)
 * rather than re-testing the broker pipeline or grants lifecycle, which
 * have their own test suites.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const { identitiesStore, consentGrantsStore, IDENTITIES_TABLE, CONSENT_GRANTS_TABLE } = vi.hoisted(() => {
  const identitiesStore = new Map<string, Row>();
  const consentGrantsStore = new Map<string, Row>();
  const IDENTITIES_TABLE = {
    __table: 'identities',
    id: 'id', publicKey: 'publicKey', metadata: 'metadata',
  };
  const CONSENT_GRANTS_TABLE = {
    __table: 'consent_grants',
    id: 'id', subject: 'subject', grantedToClass: 'grantedToClass', purpose: 'purpose',
    allowedFields: 'allowedFields', mode: 'mode', consentRef: 'consentRef', status: 'status',
  };
  return { identitiesStore, consentGrantsStore, IDENTITIES_TABLE, CONSENT_GRANTS_TABLE };
});

function storeFor(table: { __table: string }): Map<string, Row> {
  switch (table.__table) {
    case 'identities': return identitiesStore;
    case 'consent_grants': return consentGrantsStore;
    default: throw new Error(`unknown table ${table.__table}`);
  }
}

function project(rows: Row[], projection?: Record<string, string>): Row[] {
  if (!projection) return rows;
  return rows.map((row) => projectRow(row, projection));
}

function projectRow(row: Row, projection: Record<string, string>): Row {
  const result: Row = {};
  for (const key of Object.keys(projection)) result[key] = row[projection[key]];
  return result;
}

function insertInto(table: { __table: string }) {
  return {
    values: (data: Row) => {
      storeFor(table).set(String(data.id), { ...data });
      return Promise.resolve([data]);
    },
  };
}

function updateWhere(table: { __table: string }, patch: Row, predicate: Predicate) {
  const store = storeFor(table);
  for (const [key, row] of store) {
    if (predicate(row)) store.set(key, { ...row, ...patch });
  }
  return Promise.resolve([]);
}

function updateTable(table: { __table: string }) {
  return { set: (patch: Row) => ({ where: (predicate: Predicate) => updateWhere(table, patch, predicate) }) };
}

function whereClause(table: { __table: string }, projection?: Record<string, string>) {
  return {
    where: (predicate: Predicate) => {
      const rows = project([...storeFor(table).values()].filter(predicate), projection);
      return { limit: (n: number) => Promise.resolve(rows.slice(0, n)) };
    },
  };
}

function selectFrom(projection?: Record<string, string>) {
  return { from: (table: { __table: string }) => whereClause(table, projection) };
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const eq = (column: string, value: unknown): Predicate => (row) => row[column] === value;
  const and = (...preds: Predicate[]): Predicate => (row) => preds.every((p) => p(row));
  return { ...actual, eq, and };
});

vi.mock('@/src/db', () => ({
  db: { insert: insertInto, update: updateTable, select: selectFrom },
  identities: IDENTITIES_TABLE,
  consentGrants: CONSENT_GRANTS_TABLE,
}));

vi.mock('@/src/lib/kernel/id', () => {
  let counter = 0;
  return { generateId: (prefix: string) => `${prefix}_${++counter}` };
});

vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: () => Promise.resolve('did:imajin:node') }));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

const verifySignatureMock = vi.fn();
vi.mock('../crypto', () => ({ verifySignature: (...args: unknown[]) => verifySignatureMock(...args) }));

const introspectGrantMock = vi.fn();
vi.mock('../grants', () => ({ introspectGrant: (...args: unknown[]) => introspectGrantMock(...args) }));

const resolveOrMintForeignPrincipalStubMock = vi.fn();
vi.mock('../foreign-principal-stub', () => ({
  resolveOrMintForeignPrincipalStub: (...args: unknown[]) => resolveOrMintForeignPrincipalStubMock(...args),
}));

const emitAttestationMock = vi.fn().mockResolvedValue({ attestationId: 'att_1' });
vi.mock('@imajin/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@imajin/auth')>();
  return {
    ...actual,
    canonicalize: (obj: unknown) => JSON.stringify(obj),
    emitAttestation: (...args: unknown[]) => emitAttestationMock(...args),
  };
});

const brokerMock = vi.fn();
const publishMock = vi.fn().mockResolvedValue(undefined);
vi.mock('@imajin/bus', () => ({
  broker: (...args: unknown[]) => brokerMock(...args),
  publish: (...args: unknown[]) => publishMock(...args),
  isBrokerRelease: (r: { status: string }) => r.status === 'released',
}));

import { SIGNED_MESSAGE_MAX_AGE, FUTURE_TOLERANCE } from '@imajin/auth';
import { reachPrincipal, seedAgentReachGate, reachTranscript, type ReachRequestInput } from '../agent-reach';

const PRINCIPAL_DID = 'did:imajin:ryan';
const REQUESTER_DID = 'did:imajin:muse-agent';

/**
 * Pins the #2262 follow-up contract for every `reachPrincipal` path: exactly
 * one `agent.reach` attestation is minted per exchange (never zero, never a
 * duplicate on a fail-closed branch), and its payload carries only the
 * transcript's hash — never the raw transcript bytes that were signed.
 */
function expectAttestedExactlyOnce(matcher: Record<string, unknown>): void {
  expect(emitAttestationMock).toHaveBeenCalledTimes(1);
  expect(emitAttestationMock).toHaveBeenCalledWith(expect.objectContaining(matcher));
  const [attestationArgs] = emitAttestationMock.mock.calls[0] as [{ payload: Record<string, unknown> }];
  expect(attestationArgs.payload).toHaveProperty('transcriptHash');
  expect(attestationArgs.payload).not.toHaveProperty('transcript');
}

function baseInput(overrides: Partial<ReachRequestInput> = {}): ReachRequestInput {
  return {
    requesterDid: REQUESTER_DID,
    onBehalfOf: { platform: 'meta-muse', externalRef: 'alice-1', selfDescription: 'Meta Muse acting for Alice' },
    purpose: 'agent.reach',
    field: 'contact_topics',
    predicate: 'contains',
    arg: 'business_development',
    issuedAt: new Date().toISOString(),
    signature: 'deadbeef',
    ...overrides,
  };
}

describe('reachPrincipal (#2251)', () => {
  beforeEach(() => {
    identitiesStore.clear();
    consentGrantsStore.clear();
    verifySignatureMock.mockReset().mockResolvedValue(true);
    introspectGrantMock.mockReset().mockResolvedValue({ authorized: true, grantId: 'grant_1' });
    resolveOrMintForeignPrincipalStubMock.mockReset().mockResolvedValue({ did: 'did:imajin:alice-stub', isNewStub: true });
    emitAttestationMock.mockClear();
    brokerMock.mockReset().mockResolvedValue({ status: 'rejected', reason: 'no_consent', fields: ['contact_topics'] });
    publishMock.mockClear();

    identitiesStore.set(PRINCIPAL_DID, { id: PRINCIPAL_DID, publicKey: 'principal-pubkey', metadata: { agentReachTopics: ['business_development'] } });
    identitiesStore.set(REQUESTER_DID, { id: REQUESTER_DID, publicKey: 'requester-pubkey', metadata: {} });
  });

  it('denies with principal_not_found when the target DID does not exist, without ever checking the signature, but still attests the refusal', async () => {
    const result = await reachPrincipal('did:imajin:nobody', baseInput());
    expect(result).toMatchObject({ denied: true, reason: 'principal_not_found', status: 404 });
    expect(verifySignatureMock).not.toHaveBeenCalled();
    expect(publishMock).toHaveBeenCalledWith('agent.reach.denied', expect.objectContaining({
      payload: expect.objectContaining({ reason: 'principal_not_found' }),
    }));
    expectAttestedExactlyOnce({
      subject_did: 'did:imajin:nobody',
      type: 'agent.reach',
      payload: expect.objectContaining({ outcome: 'denied', reason: 'principal_not_found', signatureVerified: false }),
    });
  });

  it('denies with requester_unknown when the requester has no identity (never knocked/accepted), and attests the refusal', async () => {
    const result = await reachPrincipal(PRINCIPAL_DID, baseInput({ requesterDid: 'did:imajin:stranger' }));
    expect(result).toMatchObject({ denied: true, reason: 'requester_unknown', status: 401 });
    expect(introspectGrantMock).not.toHaveBeenCalled();
    expectAttestedExactlyOnce({
      payload: expect.objectContaining({ outcome: 'denied', reason: 'requester_unknown', signatureVerified: false }),
    });
  });

  it('denies with invalid_signature when the signature does not verify, before checking any grant, and attests the refusal honestly (signatureVerified: false)', async () => {
    verifySignatureMock.mockResolvedValue(false);
    const result = await reachPrincipal(PRINCIPAL_DID, baseInput());
    expect(result).toMatchObject({ denied: true, reason: 'invalid_signature', status: 401 });
    expect(introspectGrantMock).not.toHaveBeenCalled();
    expectAttestedExactlyOnce({
      payload: expect.objectContaining({ outcome: 'denied', reason: 'invalid_signature', signatureVerified: false }),
    });
  });

  it('denies with invalid_signature when the request timestamp is stale (older than SIGNED_MESSAGE_MAX_AGE), without ever calling verifySignature', async () => {
    const staleIssuedAt = new Date(Date.now() - SIGNED_MESSAGE_MAX_AGE - 1000).toISOString();
    const result = await reachPrincipal(PRINCIPAL_DID, baseInput({ issuedAt: staleIssuedAt }));
    expect(result).toMatchObject({ denied: true, reason: 'invalid_signature', status: 401 });
    expect(verifySignatureMock).not.toHaveBeenCalled();
    expectAttestedExactlyOnce({
      payload: expect.objectContaining({ outcome: 'denied', reason: 'invalid_signature', signatureVerified: false }),
    });
  });

  it('denies with invalid_signature when the request timestamp is too far in the future (beyond FUTURE_TOLERANCE), and attests the refusal exactly once', async () => {
    const futureIssuedAt = new Date(Date.now() + FUTURE_TOLERANCE + 5000).toISOString();
    const result = await reachPrincipal(PRINCIPAL_DID, baseInput({ issuedAt: futureIssuedAt }));
    expect(result).toMatchObject({ denied: true, reason: 'invalid_signature', status: 401 });
    expect(verifySignatureMock).not.toHaveBeenCalled();
    expectAttestedExactlyOnce({
      payload: expect.objectContaining({ outcome: 'denied', reason: 'invalid_signature', signatureVerified: false }),
    });
  });

  it('accepts a request at the exact edges of the freshness window', async () => {
    const justInsideMaxAge = new Date(Date.now() - SIGNED_MESSAGE_MAX_AGE + 1000).toISOString();
    const result = await reachPrincipal(PRINCIPAL_DID, baseInput({ issuedAt: justInsideMaxAge }));
    expect(result).not.toHaveProperty('denied');
    expect(verifySignatureMock).toHaveBeenCalled();
  });

  it('verifies the signature against the exact reachTranscript for this principal + input', async () => {
    const input = baseInput();
    await reachPrincipal(PRINCIPAL_DID, input);
    const expectedTranscript = reachTranscript(PRINCIPAL_DID, input);
    expect(verifySignatureMock).toHaveBeenCalledWith(expectedTranscript, 'deadbeef', 'requester-pubkey');
  });

  it('denies with unauthorized when there is no active agent:reach grant (fail-closed), attesting that the signature WAS verified even though the grant was missing', async () => {
    introspectGrantMock.mockResolvedValue({ authorized: false, reason: 'No active, unexpired grant covers this capability and audience' });
    const result = await reachPrincipal(PRINCIPAL_DID, baseInput());
    expect(result).toMatchObject({ denied: true, reason: 'unauthorized', status: 403 });
    expect(brokerMock).not.toHaveBeenCalled();
    expectAttestedExactlyOnce({
      payload: expect.objectContaining({ outcome: 'denied', reason: 'unauthorized', signatureVerified: true }),
    });
  });

  it('fails closed the instant the grant is revoked — same call shape as after revokeGrant() — and attests the post-revocation refusal', async () => {
    // Simulates DELETE /auth/api/grants/:grantId having just run: introspectGrant
    // re-reads storage and returns unauthorized on the very next call.
    introspectGrantMock.mockResolvedValueOnce({ authorized: true, grantId: 'grant_1' });
    const beforeRevocation = await reachPrincipal(PRINCIPAL_DID, baseInput());
    expect(beforeRevocation).not.toHaveProperty('denied');

    emitAttestationMock.mockClear();
    introspectGrantMock.mockResolvedValueOnce({ authorized: false, reason: 'revoked' });
    const afterRevocation = await reachPrincipal(PRINCIPAL_DID, baseInput());
    expect(afterRevocation).toMatchObject({ denied: true, reason: 'unauthorized', status: 403 });
    expectAttestedExactlyOnce({
      payload: expect.objectContaining({ outcome: 'denied', reason: 'unauthorized', signatureVerified: true }),
    });
  });

  it('returns answer: true and mints the agent.reach attestation when the gate matches', async () => {
    brokerMock.mockResolvedValue({
      status: 'released',
      data: { contact_topics: { field: 'contact_topics', predicate: 'contains', result: true, cacheKey: 'k1', issuedAt: 'x', expiresAt: 'y' } },
      envelope: { releaseId: 'r1', scopeId: 'agent', purpose: 'agent.reach', issuedAt: 'x', consentReference: 'c1', mode: 'attestation' },
    });

    const result = await reachPrincipal(PRINCIPAL_DID, baseInput());
    expect(result).toMatchObject({ answer: true });
    expect(result).toHaveProperty('transcriptHash');

    expectAttestedExactlyOnce({
      issuer_did: 'did:imajin:node',
      subject_did: PRINCIPAL_DID,
      type: 'agent.reach',
      context_id: REQUESTER_DID,
      context_type: 'agent.reach',
      payload: expect.objectContaining({
        requesterDid: REQUESTER_DID,
        onBehalfOfStubDid: 'did:imajin:alice-stub',
        principalDid: PRINCIPAL_DID,
        outcome: 'answered',
        signatureVerified: true,
        answer: true,
        grantId: 'grant_1',
      }),
    });

    expect(publishMock).toHaveBeenCalledWith('agent.reach.answered', expect.objectContaining({
      payload: expect.objectContaining({ answer: true, grantId: 'grant_1' }),
    }));
  });

  it('returns answer: false without disclosing the underlying topic list when the predicate does not match, attesting the answered exchange exactly once', async () => {
    brokerMock.mockResolvedValue({
      status: 'released',
      data: { contact_topics: { field: 'contact_topics', predicate: 'contains', result: false, cacheKey: 'k1', issuedAt: 'x', expiresAt: 'y' } },
      envelope: { releaseId: 'r1', scopeId: 'agent', purpose: 'agent.reach', issuedAt: 'x', consentReference: 'c1', mode: 'attestation' },
    });

    const result = await reachPrincipal(PRINCIPAL_DID, baseInput({ arg: 'unrelated_topic' }));
    expect(result).toMatchObject({ answer: false });
    expectAttestedExactlyOnce({
      payload: expect.objectContaining({ outcome: 'answered', answer: false }),
    });
  });

  it('collapses a broker rejection (e.g. no consent_grants row configured) into answer: false, never a distinct error, attesting the gate-denied exchange exactly once', async () => {
    brokerMock.mockResolvedValue({ status: 'rejected', reason: 'no_consent', fields: ['contact_topics'] });

    const result = await reachPrincipal(PRINCIPAL_DID, baseInput());
    expect(result).toMatchObject({ answer: false });
    expect(result).not.toHaveProperty('denied');
    expectAttestedExactlyOnce({
      payload: expect.objectContaining({ outcome: 'answered', answer: false }),
    });
  });

  it('passes the raw, never-disclosed gate value to broker() as data — never in the returned answer', async () => {
    brokerMock.mockResolvedValue({
      status: 'released',
      data: { contact_topics: { field: 'contact_topics', predicate: 'contains', result: true, cacheKey: 'k1', issuedAt: 'x', expiresAt: 'y' } },
      envelope: { releaseId: 'r1', scopeId: 'agent', purpose: 'agent.reach', issuedAt: 'x', consentReference: 'c1', mode: 'attestation' },
    });

    const result = await reachPrincipal(PRINCIPAL_DID, baseInput());
    expect(brokerMock).toHaveBeenCalledWith('agent.reach', expect.objectContaining({
      data: { contact_topics: ['business_development'] },
    }));
    expect(JSON.stringify(result)).not.toContain('business_development');
  });
});

describe('seedAgentReachGate (#2251)', () => {
  beforeEach(() => {
    identitiesStore.clear();
    consentGrantsStore.clear();
  });

  it('throws when the principal identity does not exist', async () => {
    await expect(seedAgentReachGate({ principalDid: 'did:imajin:nobody', topics: ['business_development'] }))
      .rejects.toThrow(/not found/);
  });

  it('merges the topic list into identities.metadata without clobbering existing metadata', async () => {
    identitiesStore.set(PRINCIPAL_DID, { id: PRINCIPAL_DID, metadata: { onboardedVia: 'seed' } });
    await seedAgentReachGate({ principalDid: PRINCIPAL_DID, topics: ['business_development', 'speaking'] });

    const row = identitiesStore.get(PRINCIPAL_DID);
    expect(row?.metadata).toMatchObject({ onboardedVia: 'seed', agentReachTopics: ['business_development', 'speaking'] });
  });

  it('is idempotent: running twice leaves exactly one active consent_grants row for the strangers class', async () => {
    identitiesStore.set(PRINCIPAL_DID, { id: PRINCIPAL_DID, metadata: {} });
    await seedAgentReachGate({ principalDid: PRINCIPAL_DID, topics: ['business_development'] });
    await seedAgentReachGate({ principalDid: PRINCIPAL_DID, topics: ['business_development'] });

    const grants = [...consentGrantsStore.values()].filter(
      (row) => row.subject === PRINCIPAL_DID && row.purpose === 'agent.reach' && row.grantedToClass === 'strangers',
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ allowedFields: ['contact_topics'], mode: 'attestation' });
  });
});
