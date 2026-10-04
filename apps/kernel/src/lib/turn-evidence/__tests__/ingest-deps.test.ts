import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { EvidenceRow } from '../ingest';

const mocks = vi.hoisted(() => ({
  selectWhere: vi.fn(),
  insertChain: { values: vi.fn(), onConflictDoNothing: vi.fn(), returning: vi.fn() },
  resolveIssuerCredentials: vi.fn(),
  computeCid: vi.fn(),
  publish: vi.fn(),
  warn: vi.fn(),
  authorizeEvidencePublisher: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  eq: (...args: unknown[]) => ({ op: 'eq', args }),
  inArray: (...args: unknown[]) => ({ op: 'inArray', args }),
  isNull: (...args: unknown[]) => ({ op: 'isNull', args }),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: mocks.selectWhere }) }),
    insert: () => ({ values: mocks.insertChain.values }),
  },
  attestations: { id: 'att.id', type: 'att.type', subjectDid: 'att.subject', revokedAt: 'att.revoked', payload: 'att.payload' },
  assets: { id: 'assets.id', ownerDid: 'assets.owner', hash: 'assets.hash', status: 'assets.status' },
}));

vi.mock('@imajin/cid', () => ({ computeCid: mocks.computeCid }));
vi.mock('@imajin/bus', () => ({ publish: mocks.publish }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ warn: mocks.warn, info: vi.fn(), error: vi.fn() }) }));
vi.mock('@/app/auth/api/attestations/attestation-helpers', () => ({
  resolveIssuerCredentials: mocks.resolveIssuerCredentials,
}));
vi.mock('../authorize-publisher', () => ({ authorizeEvidencePublisher: mocks.authorizeEvidencePublisher }));

import { productionIngestDeps, resolveIssuerKey } from '../ingest-deps';
import { signedItem, AGENT_DID, PRINCIPAL_DID, TURN_EVENT_ID } from './helpers';

function row(seq: number): EvidenceRow {
  const { payload, signature, issuedAt } = signedItem(seq);
  return {
    id: `att_${seq}`,
    issuerDid: AGENT_DID,
    subjectDid: AGENT_DID,
    type: 'agent.turn.evidence',
    contextId: TURN_EVENT_ID,
    contextType: 'agent.turn',
    payload,
    signature,
    delegatorDid: PRINCIPAL_DID,
    delegationGrantId: 'grant_1',
    issuedAt: new Date(issuedAt),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.insertChain.values.mockReturnValue({ onConflictDoNothing: mocks.insertChain.onConflictDoNothing });
  mocks.insertChain.onConflictDoNothing.mockReturnValue({ returning: mocks.insertChain.returning });
  mocks.computeCid.mockResolvedValue('bafyreicid');
  mocks.publish.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveIssuerKey', () => {
  it('returns the credentials’ public key, or null when the DID is unknown', async () => {
    mocks.resolveIssuerCredentials.mockResolvedValueOnce({ publicKey: 'abc123', appId: null });
    expect(await resolveIssuerKey(AGENT_DID)).toBe('abc123');
    mocks.resolveIssuerCredentials.mockResolvedValueOnce(null);
    expect(await resolveIssuerKey('did:imajin:nobody')).toBeNull();
  });
});

describe('findOwnUsageRefs', () => {
  it('returns the set of ids the query matched', async () => {
    mocks.selectWhere.mockResolvedValueOnce([{ id: 'att_a' }, { id: 'att_b' }]);
    const found = await productionIngestDeps.findOwnUsageRefs(['att_a', 'att_b', 'att_c'], AGENT_DID);
    expect([...found].sort((a, b) => a.localeCompare(b))).toEqual(['att_a', 'att_b']);
  });

  it('scopes the query to the agent’s own, non-revoked agent.turn.usage rows', async () => {
    mocks.selectWhere.mockResolvedValueOnce([]);
    await productionIngestDeps.findOwnUsageRefs(['att_a'], AGENT_DID);
    const condition = JSON.stringify(mocks.selectWhere.mock.calls[0][0]);
    expect(condition).toContain('agent.turn.usage');
    expect(condition).toContain(AGENT_DID);
    expect(condition).toContain('att.revoked');
  });
});

describe('findAssets', () => {
  it('maps matched active assets by id', async () => {
    mocks.selectWhere.mockResolvedValueOnce([{ id: 'asset_1', ownerDid: PRINCIPAL_DID, hash: 'ab'.repeat(32) }]);
    const found = await productionIngestDeps.findAssets(['asset_1', 'asset_2']);
    expect(found.get('asset_1')).toEqual({ ownerDid: PRINCIPAL_DID, hash: 'ab'.repeat(32) });
    expect(found.has('asset_2')).toBe(false);
    expect(JSON.stringify(mocks.selectWhere.mock.calls[0][0])).toContain('active');
  });
});

describe('insertEvidence', () => {
  it('inserts all rows in one statement with ON CONFLICT DO NOTHING and returns only the inserted seqs', async () => {
    mocks.insertChain.returning.mockResolvedValueOnce([
      { id: 'att_1', payload: { seq: 1 } },
    ]);

    const inserted = await productionIngestDeps.insertEvidence([row(0), row(1)]);

    expect(inserted).toEqual([{ id: 'att_1', seq: 1 }]);
    expect(mocks.insertChain.values).toHaveBeenCalledTimes(1);
    const values = mocks.insertChain.values.mock.calls[0][0] as Record<string, unknown>[];
    expect(values).toHaveLength(2);
    expect(mocks.insertChain.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it('writes unilateral, delegated, content-addressed rows (attestationStatus null, never pending)', async () => {
    mocks.insertChain.returning.mockResolvedValueOnce([]);
    await productionIngestDeps.insertEvidence([row(0)]);

    const [value] = mocks.insertChain.values.mock.calls[0][0] as Record<string, unknown>[];
    expect(value).toMatchObject({
      id: 'att_0',
      issuerDid: AGENT_DID,
      subjectDid: AGENT_DID,
      type: 'agent.turn.evidence',
      contextId: TURN_EVENT_ID,
      contextType: 'agent.turn',
      cid: 'bafyreicid',
      attestationStatus: null,
      delegatorDid: PRINCIPAL_DID,
      delegationGrantId: 'grant_1',
    });
  });

  it('still inserts when the CID cannot be computed (non-fatal), logging a warning', async () => {
    mocks.computeCid.mockRejectedValueOnce(new Error('cid boom'));
    mocks.insertChain.returning.mockResolvedValueOnce([]);

    await productionIngestDeps.insertEvidence([row(0)]);

    const [value] = mocks.insertChain.values.mock.calls[0][0] as Record<string, unknown>[];
    expect(value.cid).toBeNull();
    expect(mocks.warn).toHaveBeenCalledWith(expect.objectContaining({ attestationId: 'att_0' }), 'evidence cid computation failed');
  });
});

describe('announce', () => {
  it('publishes attestation.created with ids and types only — never the evidence payload', () => {
    productionIngestDeps.announce(row(0));

    expect(mocks.publish).toHaveBeenCalledTimes(1);
    const [kind, event] = mocks.publish.mock.calls[0];
    expect(kind).toBe('attestation.created');
    expect(event).toMatchObject({
      issuer: AGENT_DID,
      subject: AGENT_DID,
      scope: 'auth',
      payload: { attestationId: 'att_0', type: 'agent.turn.evidence', contextId: TURN_EVENT_ID, pendingSignature: false },
    });
    expect(JSON.stringify(event)).not.toContain('inputHash');
  });

  it('swallows and logs a publish failure instead of throwing', async () => {
    mocks.publish.mockRejectedValueOnce(new Error('bus down'));
    expect(() => productionIngestDeps.announce(row(0))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ attestationId: 'att_0' }),
      'attestation.created publish failed for turn evidence',
    );
  });
});

describe('productionIngestDeps wiring', () => {
  it('generates att_-prefixed ids', () => {
    expect(productionIngestDeps.newId()).toMatch(/^att_[0-9a-f]{24}$/);
  });

  it('reads the evidentiary allowlist from config at call time', () => {
    expect([...productionIngestDeps.evidentiaryTools()].sort((a, b) => a.localeCompare(b))).toEqual(['chain_read', 'web_fetch']);
    vi.stubEnv('TURN_EVIDENCE_EVIDENTIARY_TOOLS', 'eth_call');
    expect([...productionIngestDeps.evidentiaryTools()]).toEqual(['eth_call']);
  });

  it('authorizes through the evidence publisher gate', () => {
    expect(productionIngestDeps.authorizePublisher).toBe(mocks.authorizeEvidencePublisher);
  });
});
