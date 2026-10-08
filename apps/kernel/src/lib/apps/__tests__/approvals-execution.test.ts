/**
 * Unit tests for `executeAppsProvisionApproval` (#2375) — the bridge that
 * turns an operator's countersigned 'approve' decision on an
 * `apps:provision` proposal into the actual provisioning pipeline run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OperatorApprovalCard } from '../../notify/operator-approvals-service';

const { resolveVaultAuthorizationMock, runAppProvisionMock } = vi.hoisted(() => ({
  resolveVaultAuthorizationMock: vi.fn(),
  runAppProvisionMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('../../vault/authorization', () => ({
  resolveVaultAuthorization: resolveVaultAuthorizationMock,
}));

vi.mock('../provision', () => ({
  runAppProvision: runAppProvisionMock,
}));

import { executeAppsProvisionApproval, APPS_PROVISION_KIND } from '../approvals-execution';

const AUTHORIZED_BY = { approvalId: 'appprov_1', operatorDid: 'did:imajin:operator', contentHash: 'a'.repeat(64), decidedAt: '2026-01-01T00:00:00.000Z' };

function card(overrides: Partial<OperatorApprovalCard> = {}): OperatorApprovalCard {
  return {
    proposalId: 'appprov_1',
    operatorDid: 'did:imajin:operator',
    source: 'apps',
    kind: APPS_PROVISION_KIND,
    summary: "Provision app 'dykil' (dykil)",
    keysTouched: [],
    detail: { slug: 'dykil', displayName: 'dykil', template: null, attestationTypes: [] },
    contentHash: 'a'.repeat(64),
    status: 'approved',
    decision: null,
    outcome: null,
    appliedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveVaultAuthorizationMock.mockReturnValue(AUTHORIZED_BY);
});

describe('executeAppsProvisionApproval — countersignature gate', () => {
  it('refuses execution when no genuine operator countersignature is present', async () => {
    resolveVaultAuthorizationMock.mockReturnValue(null);

    const result = await executeAppsProvisionApproval(card());

    expect(result).toEqual({ ok: false, error: `${APPS_PROVISION_KIND} requires a countersigned operator decision` });
    expect(runAppProvisionMock).not.toHaveBeenCalled();
  });
});

describe('executeAppsProvisionApproval — kind/detail validation', () => {
  it('rejects an unrecognized kind', async () => {
    const result = await executeAppsProvisionApproval(card({ kind: 'apps:something-else' }));
    expect(result).toEqual({ ok: false, error: "Unrecognized apps proposal kind 'apps:something-else'" });
    expect(runAppProvisionMock).not.toHaveBeenCalled();
  });

  it('rejects a proposal missing slug/displayName', async () => {
    const result = await executeAppsProvisionApproval(card({ detail: { template: null } }));
    expect(result).toEqual({ ok: false, error: 'apps:provision proposal is missing slug/displayName' });
    expect(runAppProvisionMock).not.toHaveBeenCalled();
  });
});

describe('executeAppsProvisionApproval — execution', () => {
  it('runs the pipeline and returns its data on success', async () => {
    runAppProvisionMock.mockResolvedValue({
      status: 'succeeded',
      repoUrl: 'https://github.com/ima-jin/dykil',
      appDid: 'did:imajin:app-dykil',
      secretsSet: [],
      attestationTypeResults: [],
      claimCode: 'claim_test_code',
    });

    const result = await executeAppsProvisionApproval(card());

    expect(result).toEqual({
      ok: true,
      data: {
        repoUrl: 'https://github.com/ima-jin/dykil',
        appDid: 'did:imajin:app-dykil',
        secretsSet: [],
        claimCode: 'claim_test_code',
      },
    });
    expect(runAppProvisionMock).toHaveBeenCalledWith({
      slug: 'dykil',
      displayName: 'dykil',
      template: undefined,
      attestationTypes: [],
      approvedDeclarations: null,
    });
  });

  it('#2437: the one-time reveal never carries a seal flag — only repo/DID/secretsSet/claimCode', async () => {
    runAppProvisionMock.mockResolvedValue({
      status: 'succeeded',
      repoUrl: 'https://github.com/ima-jin/dykil',
      appDid: 'did:imajin:app-dykil',
      secretsSet: [],
      attestationTypeResults: [],
      claimCode: 'claim_test_code',
    });

    const result = await executeAppsProvisionApproval(card());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(Object.keys(result.data).sort()).toEqual(['appDid', 'claimCode', 'repoUrl', 'secretsSet']);
  });

  it('reports a failed pipeline outcome with the step named', async () => {
    runAppProvisionMock.mockResolvedValue({ status: 'failed', failedStep: 'app-signing-key-grant', error: 'could not grant' });

    const result = await executeAppsProvisionApproval(card());

    expect(result).toEqual({ ok: false, error: "apps.provision failed at step 'app-signing-key-grant': could not grant" });
  });

  it('passes through attestationTypes from the proposal detail', async () => {
    runAppProvisionMock.mockResolvedValue({
      status: 'succeeded',
      repoUrl: 'https://github.com/ima-jin/dykil',
      appDid: 'did:imajin:app-dykil',
      secretsSet: [],
      attestationTypeResults: [],
    });

    await executeAppsProvisionApproval(card({
      detail: { slug: 'dykil', displayName: 'dykil', attestationTypes: ['dykil/survey-response'] },
    }));

    expect(runAppProvisionMock).toHaveBeenCalledWith(expect.objectContaining({
      attestationTypes: ['dykil/survey-response'],
    }));
  });

  it('#2663: hands the pipeline the providesScopes/dependsOn/emittableEvents list the operator saw on the card', async () => {
    runAppProvisionMock.mockResolvedValue({ status: 'failed', failedStep: 'register', error: 'x' });
    const manifestDeclarations = {
      providesScopes: ['dykil:read', 'dykil:write'],
      dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read'] }],
      emittableEvents: ['tip.granted', 'tip.sent'],
    };

    await executeAppsProvisionApproval(card({ detail: { slug: 'dykil', displayName: 'dykil', manifestDeclarations } }));

    expect(runAppProvisionMock).toHaveBeenCalledWith(expect.objectContaining({ approvedDeclarations: manifestDeclarations }));
  });

  it.each([
    ['absent (no manifest was readable at proposal time)', undefined],
    ['null', null],
    ['not an object', 'dykil:read'],
    ['missing dependsOn', { providesScopes: ['dykil:read'] }],
    ['a non-string scope', { providesScopes: [1], dependsOn: [] }],
    ['a malformed dependency', { providesScopes: [], dependsOn: [{ aud: 'jin.imajin.ai' }] }],
    ['a non-string emittable event', { providesScopes: [], dependsOn: [], emittableEvents: [1] }],
  ])('#2663: approves nothing when the proposal detail snapshot is %s', async (_label, manifestDeclarations) => {
    runAppProvisionMock.mockResolvedValue({ status: 'failed', failedStep: 'register', error: 'x' });

    await executeAppsProvisionApproval(card({ detail: { slug: 'dykil', displayName: 'dykil', manifestDeclarations } }));

    expect(runAppProvisionMock).toHaveBeenCalledWith(expect.objectContaining({ approvedDeclarations: null }));
  });

  it('never throws — an unexpected pipeline exception is reported as a generic failure', async () => {
    runAppProvisionMock.mockRejectedValue(new Error('unexpected'));

    const result = await executeAppsProvisionApproval(card());

    expect(result).toEqual({ ok: false, error: 'Apps proposal execution failed' });
  });
});
