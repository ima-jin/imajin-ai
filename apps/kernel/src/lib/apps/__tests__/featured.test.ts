import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperatorApprovalCard } from '../../notify/operator-approvals-service';

const { selectMock, updateMock, setMock, whereMock, returningMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  setMock: vi.fn(),
  whereMock: vi.fn(),
  returningMock: vi.fn(),
}));
vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn() }),
}));
vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: selectMock }) }),
    update: updateMock,
  },
  registryApps: { appDid: 'appDid', status: 'status' },
  operatorApprovals: { source: 'source', kind: 'kind', status: 'status', detail: 'detail' },
}));
vi.mock('drizzle-orm', () => ({
  and: (...values: unknown[]) => values,
  eq: (...values: unknown[]) => values,
  sql: (...values: unknown[]) => values,
}));

import { executeAppsFeaturedApproval, findPendingFeaturedProposal } from '../featured';
import { APPS_FEATURED_KIND, parseAppFeaturedDetail } from '../featured-kind';
import { validateDecisionMode } from '../../notify/operator-decision-modes';

const APP = 'did:imajin:app';
const OPERATOR = 'did:imajin:operator';
function approvedCard(overrides: Partial<OperatorApprovalCard> = {}): OperatorApprovalCard {
  return {
    proposalId: 'appfeature_1', source: 'apps', kind: APPS_FEATURED_KIND,
    operatorDid: OPERATOR, summary: 'Feature app', keysTouched: [],
    detail: { appDid: APP, featured: true }, contentHash: 'a'.repeat(64),
    status: 'approved', decision: {
      proposalId: 'appfeature_1', source: 'apps', kind: APPS_FEATURED_KIND,
      decision: 'approve', decidedBy: OPERATOR, decidedAt: '2026-10-17T12:00:00Z',
      contentHash: `sha256:${'a'.repeat(64)}`,
      operatorSignature: { keyId: 'b'.repeat(64), alg: 'ed25519', sig: 'c'.repeat(128) },
    },
    outcome: null, appliedAt: null, archivedAt: null,
    createdAt: '2026-10-17T11:00:00Z', updatedAt: '2026-10-17T12:00:00Z',
    ...overrides,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  updateMock.mockReturnValue({ set: setMock });
  setMock.mockReturnValue({ where: whereMock });
  whereMock.mockReturnValue({ returning: returningMock });
  returningMock.mockResolvedValue([{ appDid: APP }]);
});

describe('featured detail and mode contract', () => {
  it.each([true, false])('accepts explicit boolean %s', (featured) => {
    expect(parseAppFeaturedDetail({ appDid: APP, featured })).toEqual({ appDid: APP, featured });
  });
  it.each([null, [], {}, { appDid: '', featured: true }, { appDid: '  ', featured: false },
    { appDid: APP }, { appDid: APP, featured: 'true' }, { appDid: APP, featured: 1 }])(
    'rejects malformed detail %j', (detail) => {
      expect(parseAppFeaturedDetail(detail)).toBeNull();
    },
  );
  it('does not accept a decision mode', () => {
    const subject = { source: 'apps', kind: APPS_FEATURED_KIND, detail: null };
    expect(validateDecisionMode(subject, 'approve', undefined)).toEqual({ ok: true });
    expect(validateDecisionMode(subject, 'approve', 'install')).toMatchObject({ ok: false });
  });
});

describe('featured execution gate', () => {
  it.each([
    ['unsigned decision', { decision: { ...approvedCard().decision!, operatorSignature: undefined } }],
    ['no decision', { decision: null }],
    ['no content hash', { contentHash: null }],
    ['pending proposal', { status: 'pending' }],
    ['denied proposal', { status: 'denied' }],
    ['rejected decision', { decision: { ...approvedCard().decision!, decision: 'reject' } }],
    ['other decider', { decision: { ...approvedCard().decision!, decidedBy: 'did:imajin:app' } }],
    ['wrong source', { source: 'other' }],
    ['wrong kind', { kind: 'apps:provision' }],
    ['malformed detail', { detail: { appDid: APP, featured: 'true' } }],
  ])('refuses %s without any mutation', async (_label, overrides) => {
    const result = await executeAppsFeaturedApproval(approvedCard(overrides as Partial<OperatorApprovalCard>));
    expect(result.ok).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
    expect(selectMock).not.toHaveBeenCalled();
  });

  it.each([true, false])('writes only featured=%s, never membership, scopes or authorization', async (featured) => {
    const result = await executeAppsFeaturedApproval(approvedCard({ detail: { appDid: APP, featured } }));
    expect(result).toEqual({ ok: true, data: { appDid: APP, featured } });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith({ featured });
    expect(whereMock).toHaveBeenCalledWith(featured
      ? [['appDid', APP], ['status', 'active']]
      : [['appDid', APP]]);
  });
  it('fails closed when the app was revoked or removed after proposal', async () => {
    returningMock.mockResolvedValue([]);
    expect(await executeAppsFeaturedApproval(approvedCard())).toEqual({ ok: false, error: 'App not found or not active' });
  });
  it('reports failed writes', async () => {
    returningMock.mockRejectedValue(new Error('db unavailable'));
    expect(await executeAppsFeaturedApproval(approvedCard())).toEqual({ ok: false, error: 'Featured execution failed' });
  });
});

describe('pending featured proposals', () => {
  it('reuses only the same featured value', async () => {
    selectMock.mockResolvedValue([
      { proposalId: 'opposite', detail: { appDid: APP, featured: false } },
      { proposalId: 'match', detail: { appDid: APP, featured: true } },
    ]);
    expect(await findPendingFeaturedProposal({ appDid: APP, featured: true })).toMatchObject({ proposalId: 'match' });
  });
  it('ignores malformed details and nonmatching proposals', async () => {
    selectMock.mockResolvedValue([{ detail: null }, { detail: { appDid: APP, featured: false } }]);
    expect(await findPendingFeaturedProposal({ appDid: APP, featured: true })).toBeUndefined();
  });
});
