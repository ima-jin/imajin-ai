/**
 * Tests for POST /api/bugs/[id]/import (#2184).
 *
 * The route itself only does auth/admin checks, delegates to
 * `importBugAsIssue`, and persists the result — the connector semantics
 * (grant/credential gates, confirm rail) are covered by
 * `lib/github/__tests__/bug-import.test.ts` and `connector.test.ts`. These
 * tests pin the HTTP-shape contract: connector-missing -> structured
 * 409/412, never a silent env-token retry; not found -> 404; pending -> 202;
 * success -> 200 with the persisted tracker/externalRef/externalUrl.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { requireAuthMock, isAdminMock, importBugAsIssueMock, updateSetMock, updateWhereMock, returningMock } = vi.hoisted(() => ({
  requireAuthMock: vi.fn(),
  isAdminMock: vi.fn(),
  importBugAsIssueMock: vi.fn(),
  updateSetMock: vi.fn(),
  updateWhereMock: vi.fn(),
  returningMock: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({ eq: (col: unknown, val: unknown) => ({ col, val }) }));

vi.mock('@imajin/auth', () => ({ requireAuth: requireAuthMock }));

vi.mock('@/src/lib/www/session-auth', () => ({ isAdmin: isAdminMock }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('@/src/db', () => ({
  db: {
    update: () => ({
      set: (values: unknown) => {
        updateSetMock(values);
        return { where: (cond: unknown) => { updateWhereMock(cond); return { returning: returningMock }; } };
      },
    }),
  },
  bugReports: { id: 'id' },
}));

// Fully mocked (not vi.importActual) so this test never pulls in the real
// connector.ts's own import graph (vault/bus/DB) — that graph is exercised by
// `lib/github/__tests__/connector.test.ts` and `bug-import.test.ts` instead.
// The error mapping below mirrors the real status mapping (also pinned
// directly in `bug-import.test.ts`) so this file can assert on the route's
// HTTP wiring without re-deriving that mapping from scratch. Built from the
// global `Response` (not `next/server`'s `NextResponse`) to sidestep any
// import-ordering concern with this hoisted mock factory.
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

vi.mock('@/src/lib/github/bug-import', () => ({
  importBugAsIssue: importBugAsIssueMock,
  bugImportConnectorErrorResponse: (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('github_no_grant')) {
      return jsonResponse({ error: 'github_connector_not_enabled' }, 412);
    }
    if (message.startsWith('github_no_credential')) {
      return jsonResponse({ error: 'github_connector_not_connected' }, 409);
    }
    if (message.startsWith('github_credential_pending')) {
      return jsonResponse({ error: 'github_connector_pending' }, 409);
    }
    return null;
  },
}));

import { POST } from '../route';

const ADMIN_DID = 'did:imajin:admin';
const BUG_ID = 'bug_123';

type RouteRequest = Parameters<typeof POST>[0];

function makeReq(): RouteRequest {
  return { headers: new Headers() } as unknown as RouteRequest;
}

function callRoute() {
  return POST(makeReq(), { params: Promise.resolve({ id: BUG_ID }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAuthMock.mockResolvedValue({ identity: { id: ADMIN_DID } });
  isAdminMock.mockReturnValue(true);
  returningMock.mockResolvedValue([{
    id: BUG_ID, status: 'imported', tracker: 'github',
    externalRef: 'ima-jin/imajin-ai#2183', externalUrl: 'https://github.com/ima-jin/imajin-ai/issues/2183',
  }]);
});

describe('POST /api/bugs/[id]/import', () => {
  it('returns 401 without importing anything when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({ error: 'Unauthorized' });

    const res = await callRoute();

    expect(res.status).toBe(401);
    expect(importBugAsIssueMock).not.toHaveBeenCalled();
  });

  it('returns 403 for a non-admin caller', async () => {
    isAdminMock.mockReturnValue(false);

    const res = await callRoute();

    expect(res.status).toBe(403);
    expect(importBugAsIssueMock).not.toHaveBeenCalled();
  });

  it('returns 412 when the acting admin has no active github:write grant — never falls back to an env token', async () => {
    importBugAsIssueMock.mockRejectedValue(new Error('github_no_grant: no active grant'));

    const res = await callRoute();

    expect(res.status).toBe(412);
    expect(await res.json()).toMatchObject({ error: 'github_connector_not_enabled' });
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the grant exists but no GitHub credential is connected', async () => {
    importBugAsIssueMock.mockRejectedValue(new Error('github_no_credential: nothing sealed'));

    const res = await callRoute();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'github_connector_not_connected' });
  });

  it('returns 409 when a sealed credential is still pending delegation approval', async () => {
    importBugAsIssueMock.mockRejectedValue(new Error('github_credential_pending: awaiting approval'));

    const res = await callRoute();

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'github_connector_pending' });
  });

  it('returns 502 for an unrelated connector failure (e.g. the GitHub API itself erroring)', async () => {
    importBugAsIssueMock.mockRejectedValue(new Error('GitHub API error 500 Internal Server Error'));

    const res = await callRoute();

    expect(res.status).toBe(502);
  });

  it('returns 404 when the bug report does not exist', async () => {
    importBugAsIssueMock.mockResolvedValue({ status: 'not_found' });

    const res = await callRoute();

    expect(res.status).toBe(404);
  });

  it('returns 202 with the proposal info when the write is pending the confirm rail', async () => {
    importBugAsIssueMock.mockResolvedValue({
      status: 'pending', proposalId: 'proposal_abc', message: 'Action proposed...',
    });

    const res = await callRoute();

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ pending: true, proposalId: 'proposal_abc' });
    expect(updateSetMock).not.toHaveBeenCalled();
  });

  it('persists the generic tracker/externalRef/externalUrl (never github_issue_number/url) on success', async () => {
    importBugAsIssueMock.mockResolvedValue({
      status: 'done',
      tracker: 'github',
      externalRef: 'ima-jin/imajin-ai#2183',
      externalUrl: 'https://github.com/ima-jin/imajin-ai/issues/2183',
      issueNumber: 2183,
    });

    const res = await callRoute();

    expect(res.status).toBe(200);
    expect(importBugAsIssueMock).toHaveBeenCalledWith(BUG_ID, ADMIN_DID);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'imported',
      tracker: 'github',
      externalRef: 'ima-jin/imajin-ai#2183',
      externalUrl: 'https://github.com/ima-jin/imajin-ai/issues/2183',
      reviewedBy: ADMIN_DID,
    }));
    const setPayload = updateSetMock.mock.calls[0][0] as Record<string, unknown>;
    expect(setPayload).not.toHaveProperty('githubIssueNumber');
    expect(setPayload).not.toHaveProperty('githubIssueUrl');
  });
});
