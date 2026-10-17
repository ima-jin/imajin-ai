/**
 * Tests for `lib/github/bug-import.ts` (#2184).
 *
 * Covers the three paths the issue calls out explicitly:
 *  - connector-missing (no grant / no credential / credential pending) —
 *    `importBugAsIssue` propagates the connector's thrown error, and
 *    `bugImportConnectorErrorResponse` maps each to a structured 409/412.
 *  - successful import — builds the issue from the report and creates the
 *    generic tracker/externalRef/externalUrl reference from the connector's
 *    response.
 *  - pending (append-tier confirm rail with no live approval window) — is
 *    forwarded rather than treated as an error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { selectWhereMock, createIssueMock } = vi.hoisted(() => ({
  selectWhereMock: vi.fn(),
  createIssueMock: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({ eq: (col: unknown, val: unknown) => ({ col, val }) }));

vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: selectWhereMock }) }),
  },
  bugReports: {},
}));

vi.mock('../connector', () => ({ createIssue: createIssueMock }));

import { importBugAsIssue, bugImportConnectorErrorResponse, BUG_TRACKER_REPO } from '../bug-import';

const ACTING_DID = 'did:imajin:operator';
const BUG_ID = 'bug_123';

function bugReport(overrides: Record<string, unknown> = {}) {
  return {
    id: BUG_ID,
    reporterDid: 'did:imajin:reporter',
    reporterName: null,
    type: 'bug',
    description: 'Everything is on fire',
    screenshotUrl: null,
    pageUrl: null,
    userAgent: null,
    viewport: null,
    status: 'new',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  selectWhereMock.mockResolvedValue([bugReport()]);
});

describe('importBugAsIssue (#2184)', () => {
  it('returns not_found without ever calling the connector when the bug report does not exist', async () => {
    selectWhereMock.mockResolvedValue([]);

    const result = await importBugAsIssue(BUG_ID, ACTING_DID);

    expect(result).toEqual({ status: 'not_found' });
    expect(createIssueMock).not.toHaveBeenCalled();
  });

  it('propagates a github_no_grant failure from the connector unmapped (no PAT/env fallback)', async () => {
    createIssueMock.mockRejectedValue(new Error('github_no_grant: no active grant'));

    await expect(importBugAsIssue(BUG_ID, ACTING_DID)).rejects.toThrow(/github_no_grant/);
  });

  it('propagates a github_no_credential failure from the connector unmapped', async () => {
    createIssueMock.mockRejectedValue(new Error('github_no_credential: nothing sealed'));

    await expect(importBugAsIssue(BUG_ID, ACTING_DID)).rejects.toThrow(/github_no_credential/);
  });

  it('creates the issue on behalf of actingDid, using the platform repo and a bug-shaped label', async () => {
    createIssueMock.mockResolvedValue({
      status: 'done',
      data: { number: 2183, html_url: 'https://github.com/ima-jin/imajin-ai/issues/2183' },
    });

    const result = await importBugAsIssue(BUG_ID, ACTING_DID);

    expect(createIssueMock).toHaveBeenCalledWith(
      ACTING_DID,
      BUG_TRACKER_REPO,
      expect.stringContaining('Everything is on fire'),
      expect.any(String),
      ['bug'],
    );
    expect(result).toEqual({
      status: 'done',
      tracker: 'github',
      externalRef: `${BUG_TRACKER_REPO}#2183`,
      externalUrl: 'https://github.com/ima-jin/imajin-ai/issues/2183',
      issueNumber: 2183,
    });
  });

  it('labels a suggestion-type report as "enhancement" instead of "bug"', async () => {
    selectWhereMock.mockResolvedValue([bugReport({ type: 'suggestion' })]);
    createIssueMock.mockResolvedValue({
      status: 'done',
      data: { number: 1, html_url: 'https://github.com/ima-jin/imajin-ai/issues/1' },
    });

    await importBugAsIssue(BUG_ID, ACTING_DID);

    expect(createIssueMock).toHaveBeenCalledWith(
      ACTING_DID, BUG_TRACKER_REPO, expect.any(String), expect.any(String), ['enhancement'],
    );
  });

  it('includes reporter/page/viewport/user-agent metadata in the issue body when present', async () => {
    selectWhereMock.mockResolvedValue([bugReport({
      pageUrl: 'https://imajin.ai/bugs',
      viewport: '1280x800',
      userAgent: 'TestAgent/1.0',
      reporterName: 'Alex',
    })]);
    createIssueMock.mockResolvedValue({
      status: 'done',
      data: { number: 2, html_url: 'https://github.com/ima-jin/imajin-ai/issues/2' },
    });

    await importBugAsIssue(BUG_ID, ACTING_DID);

    const body = createIssueMock.mock.calls[0][3] as string;
    expect(body).toContain('**Page:** https://imajin.ai/bugs');
    expect(body).toContain('**Viewport:** 1280x800');
    expect(body).toContain('**User Agent:** `TestAgent/1.0`');
    expect(body).toContain('**Name:** Alex');
  });

  it('forwards a pending (confirm-rail) result rather than treating it as an error', async () => {
    createIssueMock.mockResolvedValue({
      status: 'pending',
      proposalId: 'proposal_abc',
      message: 'Action proposed (proposalId: proposal_abc). ...',
    });

    const result = await importBugAsIssue(BUG_ID, ACTING_DID);

    expect(result).toEqual({
      status: 'pending',
      proposalId: 'proposal_abc',
      message: 'Action proposed (proposalId: proposal_abc). ...',
    });
  });
});

describe('bugImportConnectorErrorResponse (#2184)', () => {
  it.each([
    ['github_no_grant: nope', 412, 'github_connector_not_enabled'],
    ['github_no_credential: nothing sealed', 409, 'github_connector_not_connected'],
    ['github_credential_pending: awaiting approval', 409, 'github_connector_pending'],
  ])('maps %s to %i and %s', async (message, status, error) => {
    const res = bugImportConnectorErrorResponse(new Error(message));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(status);
    expect(await res!.json()).toMatchObject({ error });
  });

  it('returns null for an error it does not recognize, so the caller falls back to a generic failure', () => {
    expect(bugImportConnectorErrorResponse(new Error('boom'))).toBeNull();
  });
});
