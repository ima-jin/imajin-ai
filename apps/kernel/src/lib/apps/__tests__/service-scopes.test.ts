/**
 * Unit tests for per-app operator-approved service scopes (#2711): the pure
 * mint clamp, and `executeAppsServiceScopesApproval` — the bridge that turns a
 * countersigned 'approve' on an `apps:service-scopes` card into a write of the
 * app's approved set.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OperatorApprovalCard } from '../../notify/operator-approvals-service';

const { resolveVaultAuthorizationMock, selectWhereMock, updateWhereMock, setMock } = vi.hoisted(() => ({
  resolveVaultAuthorizationMock: vi.fn(),
  selectWhereMock: vi.fn(),
  updateWhereMock: vi.fn(),
  setMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../vault/authorization', () => ({
  resolveVaultAuthorization: resolveVaultAuthorizationMock,
}));

vi.mock('../approvals-execution', () => ({ APPS_SOURCE: 'apps' }));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (...args: unknown[]) => ({ eq: args }),
  sql: (...args: unknown[]) => ({ sql: args }),
}));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: selectWhereMock }) }),
    update: () => ({ set: setMock.mockImplementation(() => ({ where: updateWhereMock })) }),
  },
  registryApps: {
    appDid: 'registryApps.appDid',
    status: 'registryApps.status',
    requestedScopes: 'registryApps.requestedScopes',
    approvedServiceScopes: 'registryApps.approvedServiceScopes',
  },
  operatorApprovals: { source: 's', kind: 'k', status: 'st', detail: 'd' },
}));

import {
  executeAppsServiceScopesApproval,
  findPendingServiceScopesProposal,
  mintableServiceScopes,
  parseServiceScopesDetail,
} from '../service-scopes';
import { APPS_SERVICE_SCOPES_KIND } from '../service-scopes-kind';

const APP_DID = 'did:imajin:CtdP4azTs7d7avoPorZSs9DMJyGkbnw8xRU8cEsooZQU';
const DECIDED_AT = '2026-10-07T14:00:00.000Z';
const AUTHORIZED_BY = { approvalId: 'appscope_1', operatorDid: 'did:imajin:operator', contentHash: 'a'.repeat(64), decidedAt: DECIDED_AT };

function card(detail: Record<string, unknown> | null, overrides: Partial<OperatorApprovalCard> = {}): OperatorApprovalCard {
  return {
    proposalId: 'appscope_1',
    operatorDid: 'did:imajin:operator',
    source: 'apps',
    kind: APPS_SERVICE_SCOPES_KIND,
    summary: 'App requests service scopes',
    keysTouched: [],
    detail,
    contentHash: 'a'.repeat(64),
    status: 'approved',
    decision: null,
    outcome: null,
    appliedAt: null,
    createdAt: '2026-10-07T13:00:00.000Z',
    updatedAt: '2026-10-07T13:00:00.000Z',
    ...overrides,
  } as OperatorApprovalCard;
}

const grant = (scopes: string[]) => card({ appDid: APP_DID, action: 'grant', scopes });
const revoke = (scopes: string[]) => card({ appDid: APP_DID, action: 'revoke', scopes });

function appRow(approved: string[], status = 'active', requested: string[] = []) {
  selectWhereMock.mockResolvedValueOnce([{ status, approved, requested }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveVaultAuthorizationMock.mockReturnValue(AUTHORIZED_BY);
  updateWhereMock.mockResolvedValue(undefined);
});

describe('mintableServiceScopes', () => {
  it.each(['profile:email:read', 'profile:contact:backfill'])('mints %s only through explicit approval, never requests alone', async (scope) => {
    expect(mintableServiceScopes([scope], [])).toEqual([]);
    appRow([]);
    const approved = await executeAppsServiceScopesApproval(grant([scope]));
    expect(approved).toMatchObject({ ok: true, data: { approvedServiceScopes: [scope] } });
    expect(mintableServiceScopes([], [scope])).toEqual([scope]);
    expect(setMock).toHaveBeenLastCalledWith(expect.objectContaining({
      approvedServiceScopes: [scope], requestedScopes: [scope],
    }));
    appRow([scope], 'active', [scope]);
    const revoked = await executeAppsServiceScopesApproval(revoke([scope]));
    expect(revoked).toMatchObject({ ok: true, data: { approvedServiceScopes: [] } });
    expect(mintableServiceScopes([scope], [])).toEqual([]);
  });
  it('mints notify endpoint scopes only when operator-approved, including implicit requests', () => {
    const notifyScopes = ['notify:send', 'notify:broadcast', 'notify:interest'];
    expect(mintableServiceScopes(notifyScopes, [])).toEqual([]);
    expect(mintableServiceScopes([], notifyScopes)).toEqual(notifyScopes);
    expect(mintableServiceScopes(notifyScopes, notifyScopes)).toEqual(notifyScopes);
    expect(mintableServiceScopes(notifyScopes, ['notify:send'])).toEqual(['notify:send']);
  });
  it('is empty for unapproved requestedScopes alone and treats approval as a request', () => {
    expect(mintableServiceScopes(['identity:write'], [])).toEqual([]);
    expect(mintableServiceScopes([], ['identity:write'])).toEqual(['identity:write']);
    expect(mintableServiceScopes(undefined, ['identity:write'])).toEqual(['identity:write']);
    expect(mintableServiceScopes(null, undefined)).toEqual([]);
  });

  it('returns effective requests ∩ (eligible ∪ approved), clamped to the vocabulary', () => {
    expect(mintableServiceScopes(['identity:write', 'supply:read', 'bogus:scope'], ['identity:write', 'bogus:scope'])).toEqual([
      'identity:write',
      'supply:read',
    ]);
  });
});

describe('mintableServiceScopes — duplicate and stale scopes', () => {
  it('deduplicates explicit and implicit requests and rejects unknown approvals', () => {
    expect(mintableServiceScopes(
      ['attestations:write', 'attestations:write'],
      ['attestations:write', 'media:write', 'media:write', 'bogus:scope'],
    )).toEqual(['attestations:write', 'media:write']);
  });
});

describe('parseServiceScopesDetail', () => {
  it('normalizes a valid detail', () => {
    expect(parseServiceScopesDetail({ appDid: APP_DID, action: 'grant', scopes: ['b:x', 'a:x', 'a:x'] })).toEqual({
      appDid: APP_DID,
      action: 'grant',
      scopes: ['a:x', 'b:x'],
    });
  });

  it.each([
    [null],
    [{ action: 'grant', scopes: ['identity:write'] }],
    [{ appDid: APP_DID, action: 'nuke', scopes: ['identity:write'] }],
    [{ appDid: APP_DID, action: 'grant', scopes: [] }],
    [{ appDid: APP_DID, action: 'grant', scopes: [1] }],
    [{ appDid: APP_DID, action: 'grant', scopes: Array.from({ length: 21 }, (_, i) => `s${i}:x`) }],
  ])('rejects a malformed detail %#', (detail) => {
    expect(parseServiceScopesDetail(detail as Record<string, unknown> | null)).toBeNull();
  });
});

describe('executeAppsServiceScopesApproval — countersignature gate', () => {
  it('refuses, and never reads or writes the app, when the decision was not countersigned', async () => {
    resolveVaultAuthorizationMock.mockReturnValue(null);

    const result = await executeAppsServiceScopesApproval(grant(['identity:write']));

    expect(result).toEqual({ ok: false, error: `${APPS_SERVICE_SCOPES_KIND} requires a countersigned operator decision` });
    expect(selectWhereMock).not.toHaveBeenCalled();
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe('executeAppsServiceScopesApproval — validation', () => {
  it('rejects an unrecognized kind', async () => {
    const result = await executeAppsServiceScopesApproval(card({ appDid: APP_DID, action: 'grant', scopes: ['identity:write'] }, { kind: 'apps:other' }));
    expect(result).toEqual({ ok: false, error: "Unrecognized apps proposal kind 'apps:other'" });
    expect(setMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed detail', async () => {
    const result = await executeAppsServiceScopesApproval(card({ appDid: APP_DID }));
    expect(result.ok).toBe(false);
    expect(setMock).not.toHaveBeenCalled();
  });

  it('refuses to grant a scope outside the vocabulary', async () => {
    const result = await executeAppsServiceScopesApproval(grant(['bogus:scope']));
    expect(result).toEqual({ ok: false, error: `${APPS_SERVICE_SCOPES_KIND} proposal names a scope outside the vocabulary` });
    expect(setMock).not.toHaveBeenCalled();
  });

  it('fails for an unknown app', async () => {
    selectWhereMock.mockResolvedValueOnce([]);
    const result = await executeAppsServiceScopesApproval(grant(['identity:write']));
    expect(result).toEqual({ ok: false, error: `Unknown app DID '${APP_DID}'` });
    expect(setMock).not.toHaveBeenCalled();
  });

  it('refuses to grant to a revoked app', async () => {
    appRow([], 'revoked');
    const result = await executeAppsServiceScopesApproval(grant(['identity:write']));
    expect(result).toEqual({ ok: false, error: `App '${APP_DID}' is not active` });
    expect(setMock).not.toHaveBeenCalled();
  });
});

describe('executeAppsServiceScopesApproval — execution', () => {
  it('grant: stores the union on the app with the approval id + decision timestamp', async () => {
    appRow(['identity:read'], 'active', ['supply:read']);

    const result = await executeAppsServiceScopesApproval(grant(['identity:write', 'identity:read']));

    expect(result).toEqual({
      ok: true,
      data: { appDid: APP_DID, action: 'grant', approvedServiceScopes: ['identity:read', 'identity:write'] },
    });
    expect(setMock).toHaveBeenCalledWith({
      approvedServiceScopes: ['identity:read', 'identity:write'],
      requestedScopes: ['identity:read', 'identity:write', 'supply:read'],
      serviceScopesApprovalId: 'appscope_1',
      serviceScopesApprovedAt: new Date(DECIDED_AT),
    });
  });

  it('granting twice records requests and approvals without duplicates', async () => {
    const scopes = ['attestations:write', 'media:write'];
    appRow([]);
    await executeAppsServiceScopesApproval(grant(scopes));
    expect(setMock).toHaveBeenLastCalledWith(expect.objectContaining({
      approvedServiceScopes: scopes,
      requestedScopes: scopes,
    }));

    appRow(scopes, 'active', scopes);
    await executeAppsServiceScopesApproval(grant(scopes));
    expect(setMock).toHaveBeenLastCalledWith(expect.objectContaining({
      approvedServiceScopes: scopes,
      requestedScopes: scopes,
    }));
    expect(setMock).toHaveBeenCalledTimes(2);
  });

  it('revoke: removes only the named scopes, and works on a revoked app', async () => {
    appRow(['identity:read', 'identity:write'], 'revoked');

    const result = await executeAppsServiceScopesApproval(revoke(['identity:write']));

    expect(result).toEqual({ ok: true, data: { appDid: APP_DID, action: 'revoke', approvedServiceScopes: ['identity:read'] } });
    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ approvedServiceScopes: ['identity:read'] }));
    expect(setMock.mock.calls[0][0]).not.toHaveProperty('requestedScopes');
  });

  it('reports a failed write without throwing', async () => {
    appRow([]);
    updateWhereMock.mockRejectedValueOnce(new Error('db down'));

    const result = await executeAppsServiceScopesApproval(grant(['identity:write']));

    expect(result).toEqual({ ok: false, error: 'Service-scopes execution failed' });
  });
});

describe('findPendingServiceScopesProposal', () => {
  const detail = { appDid: APP_DID, action: 'grant' as const, scopes: ['identity:read', 'identity:write'] };

  it('reuses a pending proposal with the same app, action and scope set', async () => {
    selectWhereMock.mockResolvedValueOnce([
      { proposalId: 'other', detail: { appDid: APP_DID, action: 'revoke', scopes: ['identity:read', 'identity:write'] } },
      { proposalId: 'match', detail: { appDid: APP_DID, action: 'grant', scopes: ['identity:write', 'identity:read'] } },
    ]);
    await expect(findPendingServiceScopesProposal(detail)).resolves.toMatchObject({ proposalId: 'match' });
  });

  it('returns undefined when nothing matches', async () => {
    selectWhereMock.mockResolvedValueOnce([{ proposalId: 'x', detail: { appDid: APP_DID, action: 'grant', scopes: ['identity:read'] } }]);
    await expect(findPendingServiceScopesProposal(detail)).resolves.toBeUndefined();
  });
});
