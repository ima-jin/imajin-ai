/**
 * Unit tests for `POST`/`GET /api/apps/provision` (#2375) — the propose +
 * status-poll route for apps.provision's operator-approvals proposal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  requireAuthMock,
  resolveActingDidMock,
  getOperatorDidMock,
  computeApprovalContentHashMock,
  recordApprovalRequestedMock,
  findPendingAppsProvisionProposalMock,
  getAppProvisionStatusMock,
  previewManifestDeclarationsMock,
} = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  resolveActingDidMock: vi.fn(),
  getOperatorDidMock: vi.fn(),
  computeApprovalContentHashMock: vi.fn(),
  recordApprovalRequestedMock: vi.fn(),
  findPendingAppsProvisionProposalMock: vi.fn(),
  getAppProvisionStatusMock: vi.fn(),
  previewManifestDeclarationsMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: requireAuthMock,
  resolveActingDid: resolveActingDidMock,
}));

vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({}),
  corsOptions: () => new Response(null, { status: 204 }),
}));

vi.mock('@/src/lib/kernel/id', () => ({
  generateId: (prefix: string) => `${prefix}_testid`,
}));

vi.mock('@/src/lib/notify/operator-approvals', () => ({
  getOperatorDid: getOperatorDidMock,
  computeApprovalContentHash: computeApprovalContentHashMock,
}));

vi.mock('@/src/lib/notify/operator-approvals-service', () => ({
  recordApprovalRequested: recordApprovalRequestedMock,
}));

vi.mock('@/src/lib/apps/provision-proposals', () => ({
  findPendingAppsProvisionProposal: findPendingAppsProvisionProposalMock,
}));

vi.mock('@/src/lib/apps/approvals-execution', () => ({
  APPS_SOURCE: 'apps',
  APPS_PROVISION_KIND: 'apps:provision',
}));

vi.mock('@/src/lib/apps/provision', () => ({
  getAppProvisionStatus: getAppProvisionStatusMock,
}));

vi.mock('@/src/lib/apps/manifest-preview', () => ({
  previewManifestDeclarations: previewManifestDeclarationsMock,
}));

import { OPTIONS, POST, GET } from '../route';

const ACTING_DID = 'did:imajin:agent';
const OPERATOR_DID = 'did:imajin:operator';

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/apps/provision', { method: 'POST', body: JSON.stringify(body) });
}

function getRequest(query: string): Request {
  return new Request(`http://localhost/api/apps/provision${query}`, { method: 'GET' });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthMock.mockResolvedValue({ identity: { id: ACTING_DID } });
  resolveActingDidMock.mockReturnValue(ACTING_DID);
  getOperatorDidMock.mockResolvedValue(OPERATOR_DID);
  computeApprovalContentHashMock.mockReturnValue('a'.repeat(64));
  getAppProvisionStatusMock.mockResolvedValue(undefined);
  findPendingAppsProvisionProposalMock.mockResolvedValue(undefined);
  recordApprovalRequestedMock.mockResolvedValue(undefined);
  // Default: no manifest was readable at proposal time.
  previewManifestDeclarationsMock.mockResolvedValue({ ok: null });
});

describe('POST /api/apps/provision — auth + validation', () => {
  it('returns the auth error verbatim when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const response = await POST(postRequest({ slug: 'dykil', displayName: 'dykil' }) as never);

    expect(response.status).toBe(401);
    expect(recordApprovalRequestedMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid slug', async () => {
    const response = await POST(postRequest({ slug: 'Dykil!', displayName: 'dykil' }) as never);
    expect(response.status).toBe(400);
  });

  it('rejects a missing displayName', async () => {
    const response = await POST(postRequest({ slug: 'dykil' }) as never);
    expect(response.status).toBe(400);
  });

  it('rejects invalid JSON', async () => {
    const request = new Request('http://localhost/api/apps/provision', { method: 'POST', body: '{not json' });
    const response = await POST(request as never);
    expect(response.status).toBe(400);
  });

  it('rejects a template longer than the max length', async () => {
    const response = await POST(postRequest({ slug: 'dykil', displayName: 'dykil', template: 'x'.repeat(201) }) as never);
    expect(response.status).toBe(400);
  });

  it('rejects a non-array attestationTypes', async () => {
    const response = await POST(postRequest({ slug: 'dykil', displayName: 'dykil', attestationTypes: 'not-an-array' }) as never);
    expect(response.status).toBe(400);
  });

  it('rejects an attestationTypes array longer than the max length', async () => {
    const response = await POST(postRequest({
      slug: 'dykil',
      displayName: 'dykil',
      attestationTypes: Array.from({ length: 21 }, (_, i) => `dykil/type-${i}`),
    }) as never);
    expect(response.status).toBe(400);
  });

  it('rejects an attestationTypes array containing a non-string/empty entry', async () => {
    const response = await POST(postRequest({ slug: 'dykil', displayName: 'dykil', attestationTypes: ['dykil/valid', ''] }) as never);
    expect(response.status).toBe(400);
  });
});

describe('OPTIONS /api/apps/provision', () => {
  it('returns a CORS preflight response', async () => {
    const response = await OPTIONS(new Request('http://localhost/api/apps/provision', { method: 'OPTIONS' }) as never);
    expect(response.status).toBe(204);
  });
});

describe('POST /api/apps/provision — idempotency', () => {
  it('returns the cached result for an already-succeeded slug without raising a proposal', async () => {
    getAppProvisionStatusMock.mockResolvedValue({
      slug: 'dykil',
      status: 'succeeded',
      appDid: 'did:imajin:app-dykil',
      repoUrl: 'https://github.com/ima-jin/dykil',
      secretsSet: ['IMAJIN_APP_PRIVATE_KEY'],
    });

    const response = await POST(postRequest({ slug: 'dykil', displayName: 'dykil' }) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: 'succeeded',
      slug: 'dykil',
      appDid: 'did:imajin:app-dykil',
      repoUrl: 'https://github.com/ima-jin/dykil',
      secretsSet: ['IMAJIN_APP_PRIVATE_KEY'],
    });
    expect(recordApprovalRequestedMock).not.toHaveBeenCalled();
  });

  it('reuses an already-pending proposal for the same slug rather than raising a duplicate', async () => {
    findPendingAppsProvisionProposalMock.mockResolvedValue({ proposalId: 'appprov_existing' });

    const response = await POST(postRequest({ slug: 'dykil', displayName: 'dykil' }) as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ status: 'pending', proposalId: 'appprov_existing' });
    expect(recordApprovalRequestedMock).not.toHaveBeenCalled();
  });

  it('#2411: raises a fresh proposal for an already-succeeded slug when reissueClaim is true', async () => {
    getAppProvisionStatusMock.mockResolvedValue({
      slug: 'dykil',
      status: 'succeeded',
      appDid: 'did:imajin:app-dykil',
      repoUrl: 'https://github.com/ima-jin/dykil',
      secretsSet: ['IMAJIN_APP_PRIVATE_KEY'],
    });

    const response = await POST(postRequest({ slug: 'dykil', displayName: 'dykil', reissueClaim: true }) as never);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({ status: 'pending', proposalId: 'appprov_testid' });
    expect(recordApprovalRequestedMock).toHaveBeenCalled();
  });

  it('#2707: flags the reissue on the card (summary + detail.reissueClaim) and skips the manifest read', async () => {
    getAppProvisionStatusMock.mockResolvedValue({ slug: 'dykil', status: 'succeeded', appDid: 'did:imajin:app-dykil', repoUrl: 'https://github.com/ima-jin/dykil', secretsSet: [] });
    previewManifestDeclarationsMock.mockResolvedValue({ error: 'must not be consulted for a reissue' });

    const response = await POST(postRequest({ slug: 'dykil', displayName: 'Dykil', reissueClaim: true }) as never);

    expect(response.status).toBe(201);
    expect(previewManifestDeclarationsMock).not.toHaveBeenCalled();
    const recorded = recordApprovalRequestedMock.mock.calls[0][0] as { summary: string; detail: Record<string, unknown> };
    expect(recorded.detail).toMatchObject({ slug: 'dykil', displayName: 'Dykil', reissueClaim: true, manifestDeclarations: null });
    expect(recorded.summary).toMatch(/^Reissue the claim code for app 'dykil'/);
    // The same detail is what the content hash covers, so the operator signs "reissue" and nothing else.
    expect(computeApprovalContentHashMock).toHaveBeenCalledWith(expect.objectContaining({ detail: recorded.detail }));
  });

  it('#2707: an ordinary proposal carries no reissueClaim key (its detail and hash are unchanged)', async () => {
    await POST(postRequest({ slug: 'dykil', displayName: 'dykil' }) as never);

    const recorded = recordApprovalRequestedMock.mock.calls[0][0] as { detail: Record<string, unknown> };
    expect(recorded.detail).not.toHaveProperty('reissueClaim');
  });
});

describe('POST /api/apps/provision — raising a new proposal', () => {
  it('records a new proposal with signerDid set to the acting DID', async () => {
    const response = await POST(postRequest({
      slug: 'dykil',
      displayName: 'dykil',
      attestationTypes: ['dykil/survey-response'],
    }) as never);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({ status: 'pending', proposalId: 'appprov_testid' });
    expect(recordApprovalRequestedMock).toHaveBeenCalledWith(expect.objectContaining({
      proposalId: 'appprov_testid',
      operatorDid: OPERATOR_DID,
      source: 'apps',
      kind: 'apps:provision',
      signerDid: ACTING_DID,
      detail: expect.objectContaining({ slug: 'dykil', displayName: 'dykil', attestationTypes: ['dykil/survey-response'] }),
    }));
  });

  it('fails closed with 500 when no node operator is configured', async () => {
    getOperatorDidMock.mockResolvedValue(null);

    const response = await POST(postRequest({ slug: 'dykil', displayName: 'dykil' }) as never);

    expect(response.status).toBe(500);
    expect(recordApprovalRequestedMock).not.toHaveBeenCalled();
  });

  it('fails closed with 500 and logs when recording the proposal itself throws', async () => {
    recordApprovalRequestedMock.mockRejectedValue(new Error('db unavailable'));

    const response = await POST(postRequest({ slug: 'dykil', displayName: 'dykil' }) as never);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: 'Failed to raise apps.provision proposal' });
  });
});

describe('POST /api/apps/provision — scope declarations on the card (#2663)', () => {
  const declarations = {
    providesScopes: ['dykil:read', 'dykil:write'],
    dependsOn: [{ aud: 'jin.imajin.ai', scopes: ['media:read', 'media:write'] }],
  };

  it('snapshots the manifest declarations into the proposal detail the operator signs', async () => {
    previewManifestDeclarationsMock.mockResolvedValue({ ok: declarations });

    const response = await POST(postRequest({ slug: 'dykil', displayName: 'dykil' }) as never);

    expect(response.status).toBe(201);
    expect(previewManifestDeclarationsMock).toHaveBeenCalledWith('dykil');
    const recorded = recordApprovalRequestedMock.mock.calls[0][0] as { detail: Record<string, unknown> };
    expect(recorded.detail.manifestDeclarations).toEqual(declarations);
    // ...and the same detail is what the content hash covers.
    expect(computeApprovalContentHashMock).toHaveBeenCalledWith(expect.objectContaining({ detail: recorded.detail }));
  });

  it('records null — "nothing was read" — when no manifest was readable', async () => {
    const response = await POST(postRequest({ slug: 'dykil', displayName: 'dykil' }) as never);

    expect(response.status).toBe(201);
    const recorded = recordApprovalRequestedMock.mock.calls[0][0] as { detail: Record<string, unknown> };
    expect(recorded.detail).toHaveProperty('manifestDeclarations', null);
  });

  it('refuses with 400 and raises no proposal when the manifest declares something invalid', async () => {
    previewManifestDeclarationsMock.mockResolvedValue({ error: 'providesScopes rejected: media:write' });

    const response = await POST(postRequest({ slug: 'dykil', displayName: 'dykil' }) as never);
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain('media:write');
    expect(recordApprovalRequestedMock).not.toHaveBeenCalled();
  });

  it('does not read the manifest when an existing result or pending proposal is reused', async () => {
    findPendingAppsProvisionProposalMock.mockResolvedValue({ proposalId: 'appprov_existing' });

    await POST(postRequest({ slug: 'dykil', displayName: 'dykil' }) as never);

    expect(previewManifestDeclarationsMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/apps/provision', () => {
  it('returns the auth error verbatim when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Not authenticated', status: 401 });

    const response = await GET(getRequest('?slug=dykil') as never);

    expect(response.status).toBe(401);
  });

  it('requires a slug query parameter', async () => {
    const response = await GET(getRequest('') as never);
    expect(response.status).toBe(400);
  });

  it('returns 404 when no run exists for the slug', async () => {
    const response = await GET(getRequest('?slug=unknown') as never);
    expect(response.status).toBe(404);
  });

  it('returns the current ledger row for a known slug', async () => {
    getAppProvisionStatusMock.mockResolvedValue({
      slug: 'dykil',
      status: 'failed',
      appDid: 'did:imajin:app-dykil',
      repoUrl: 'https://github.com/ima-jin/dykil',
      secretsSet: [],
      attestationTypes: [],
      failedStep: 'seal',
      errorMessage: 'GitHub 403',
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const response = await GET(getRequest('?slug=dykil') as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ slug: 'dykil', status: 'failed', failedStep: 'seal', errorMessage: 'GitHub 403' });
  });
});
