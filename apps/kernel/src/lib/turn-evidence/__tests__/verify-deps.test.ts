import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  orderBy: vi.fn(),
  limit: vi.fn(),
  where: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ op: 'and', args }),
  asc: (...args: unknown[]) => ({ op: 'asc', args }),
  eq: (...args: unknown[]) => ({ op: 'eq', args }),
  isNull: (...args: unknown[]) => ({ op: 'isNull', args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'sql', text: strings.join('?'), values }),
}));

vi.mock('@/src/db', () => {
  const chain = () => ({ from: () => ({ where: mocks.where }) });
  return {
    db: { select: chain },
    attestations: {
      id: 'att.id',
      issuerDid: 'att.issuer',
      subjectDid: 'att.subject',
      type: 'att.type',
      contextId: 'att.context_id',
      contextType: 'att.context_type',
      payload: 'att.payload',
      signature: 'att.signature',
      issuedAt: 'att.issued_at',
      revokedAt: 'att.revoked_at',
    },
    auditLog: { id: 'log.id', eventType: 'log.type', issuer: 'log.issuer', payload: 'log.payload', createdAt: 'log.created' },
  };
});

vi.mock('../ingest-deps', () => ({ resolveIssuerKey: vi.fn(async () => 'pubkey') }));

import { productionVerifyDeps, VERIFY_ROW_LIMIT } from '../verify-deps';
import { CLAIM_HASH, AGENT_DID, TURN_EVENT_ID } from './helpers';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.where.mockReturnValue({ orderBy: mocks.orderBy, limit: mocks.limit });
  mocks.orderBy.mockReturnValue({ limit: mocks.limit });
});

describe('findEvidenceByTurnOutputHash', () => {
  it('queries only live agent.turn.evidence rows for the claim hash, oldest first, bounded', async () => {
    const rows = [{ id: 'att_1' }];
    mocks.limit.mockResolvedValueOnce(rows);

    const found = await productionVerifyDeps.findEvidenceByTurnOutputHash(CLAIM_HASH);

    expect(found).toBe(rows);
    const condition = JSON.stringify(mocks.where.mock.calls[0][0]);
    expect(condition).toContain('agent.turn.evidence');
    expect(condition).toContain('att.revoked_at');
    expect(condition).toContain(CLAIM_HASH);
    expect(condition).toContain("->>'turnOutputHash' = ");
    expect(mocks.limit).toHaveBeenCalledWith(VERIFY_ROW_LIMIT);
  });
});

describe('resolveTurnEvent', () => {
  it('maps a turn-typed audit-log row to a turn reference', async () => {
    mocks.limit.mockResolvedValueOnce([
      {
        id: TURN_EVENT_ID,
        eventType: 'agent.turn',
        issuer: AGENT_DID,
        payload: { outputHash: CLAIM_HASH, usageRef: 'att_u' },
        createdAt: new Date('2026-09-04T00:00:00Z'),
      },
    ]);

    const turn = await productionVerifyDeps.resolveTurnEvent(TURN_EVENT_ID);

    expect(turn).toMatchObject({ id: TURN_EVENT_ID, outputHash: CLAIM_HASH, usageRef: 'att_u' });
  });

  it('is null for an unknown id and for an unrelated bus event cited as a turn', async () => {
    mocks.limit.mockResolvedValueOnce([]);
    expect(await productionVerifyDeps.resolveTurnEvent('missing')).toBeNull();

    mocks.limit.mockResolvedValueOnce([
      { id: 'evt_1', eventType: 'attestation.created', issuer: AGENT_DID, payload: {}, createdAt: new Date() },
    ]);
    expect(await productionVerifyDeps.resolveTurnEvent('evt_1')).toBeNull();
  });
});

describe('usageExists', () => {
  it('is true only for a live agent.turn.usage row owned by the agent', async () => {
    mocks.limit.mockResolvedValueOnce([{ id: 'att_u' }]);
    expect(await productionVerifyDeps.usageExists('att_u', AGENT_DID)).toBe(true);
    const condition = JSON.stringify(mocks.where.mock.calls[0][0]);
    expect(condition).toContain('agent.turn.usage');
    expect(condition).toContain(AGENT_DID);

    mocks.limit.mockResolvedValueOnce([]);
    expect(await productionVerifyDeps.usageExists('att_missing', AGENT_DID)).toBe(false);
  });
});

describe('resolveIssuerKey', () => {
  it('is shared with the ingest path', async () => {
    expect(await productionVerifyDeps.resolveIssuerKey(AGENT_DID)).toBe('pubkey');
  });
});
