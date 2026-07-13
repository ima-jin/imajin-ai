import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sealMock, loadMock, whereMock, publishMock } = vi.hoisted(() => ({
  sealMock: vi.fn(),
  loadMock: vi.fn(),
  whereMock: vi.fn(),
  publishMock: vi.fn(),
}));

vi.mock('@/src/lib/vault', () => ({ sealAndStore: sealMock, loadAndUnseal: loadMock }));
vi.mock('@/src/db', () => ({
  db: { select: () => ({ from: () => ({ where: whereMock }) }) },
  channelLinks: { channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes' },
}));
vi.mock('@imajin/bus', () => ({ publish: publishMock }));

import {
  resolveActiveGrant,
  sealPat,
  createIssue,
  createComment,
  listIssues,
  getIssue,
  vaultField,
  GITHUB_CONNECTOR_DID,
} from '../connector';

const OWNER = 'did:imajin:eric';
const REPO = 'a-r-t-i-f-a-c-t/artifactagent';
const PAT = 'ghp_REDACTED';

const MOCK_ISSUE = {
  number: 42,
  html_url: `https://github.com/${REPO}/issues/42`,
  title: 'Test Issue',
  state: 'open',
  body: 'Issue body',
  user: { login: 'eric' },
  created_at: '2026-07-13T00:00:00.000Z',
  updated_at: '2026-07-13T00:00:00.000Z',
};

const MOCK_COMMENT = {
  id: 999,
  html_url: `https://github.com/${REPO}/issues/42#issuecomment-999`,
  body: 'Test comment',
  user: { login: 'eric' },
  created_at: '2026-07-13T00:00:00.000Z',
};

function grant(scopes: string[]) {
  whereMock.mockResolvedValue([{ scopes }]);
}

function noGrant() {
  whereMock.mockResolvedValue([]);
}

beforeEach(() => {
  sealMock.mockReset();
  sealMock.mockResolvedValue(undefined);
  loadMock.mockReset();
  loadMock.mockResolvedValue(PAT);
  whereMock.mockReset();
  publishMock.mockReset();
  publishMock.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── vaultField ────────────────────────────────────────────────────────────────

describe('vaultField', () => {
  it('encodes the ownerDid in the field name for per-DID isolation', () => {
    expect(vaultField(OWNER)).toBe(`github-pat:${OWNER}`);
  });
});

// ── resolveActiveGrant ────────────────────────────────────────────────────────

describe('resolveActiveGrant (#1228)', () => {
  it('is true when an active row includes the required scope', async () => {
    grant(['github:write']);
    expect(await resolveActiveGrant(OWNER, 'github:write')).toBe(true);
  });

  it('is false when the active row does not include the required scope', async () => {
    grant(['github:read']);
    expect(await resolveActiveGrant(OWNER, 'github:write')).toBe(false);
  });

  it('is false when there are no rows at all', async () => {
    noGrant();
    expect(await resolveActiveGrant(OWNER, 'github:write')).toBe(false);
  });
});

// ── sealPat ───────────────────────────────────────────────────────────────────

describe('sealPat (#1228)', () => {
  it('seals the PAT under the per-DID vault field', async () => {
    await sealPat(OWNER, PAT);
    expect(sealMock).toHaveBeenCalledOnce();
    const [field, plaintext] = sealMock.mock.calls[0];
    expect(field).toBe(vaultField(OWNER));
    expect(plaintext).toBe(PAT);
  });
});

// ── createIssue ───────────────────────────────────────────────────────────────

describe('createIssue (#1228)', () => {
  it('fails closed when there is no grant — never calls the API', async () => {
    noGrant();
    await expect(createIssue(OWNER, REPO, 'Title', 'Body')).rejects.toThrow(/github_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when no PAT is sealed', async () => {
    grant(['github:write']);
    loadMock.mockResolvedValue(undefined);
    await expect(createIssue(OWNER, REPO, 'Title', 'Body')).rejects.toThrow(/github_no_pat/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts to the correct GitHub API endpoint and returns the issue', async () => {
    grant(['github:write']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_ISSUE,
    });

    const result = await createIssue(OWNER, REPO, 'Test Issue', 'Issue body');

    expect(result).toMatchObject({ number: 42, html_url: MOCK_ISSUE.html_url });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${REPO}/issues`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ title: 'Test Issue', body: 'Issue body' });
    expect(init.headers['Authorization']).toBe(`Bearer ${PAT}`);
  });

  it('publishes a github.issue.created bus event after a successful create', async () => {
    grant(['github:write']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_ISSUE,
    });

    await createIssue(OWNER, REPO, 'Test Issue', 'Body');

    expect(publishMock).toHaveBeenCalledOnce();
    const [eventType, payload] = publishMock.mock.calls[0];
    expect(eventType).toBe('github.issue.created');
    expect(payload.issuer).toBe(OWNER);
    expect(payload.payload.issueNumber).toBe(MOCK_ISSUE.number);
    expect(payload.payload.repo).toBe(REPO);
  });

  it('does not throw when the bus publish fails (non-fatal)', async () => {
    grant(['github:write']);
    publishMock.mockRejectedValue(new Error('bus down'));
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_ISSUE,
    });

    await expect(createIssue(OWNER, REPO, 'Title', 'Body')).resolves.toMatchObject({ number: 42 });
  });

  it('throws a descriptive error on a non-2xx GitHub API response', async () => {
    grant(['github:write']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => 'Repository not found',
    });

    await expect(createIssue(OWNER, REPO, 'Title', 'Body')).rejects.toThrow(/GitHub API error 404/);
  });
});

// ── createComment ─────────────────────────────────────────────────────────────

describe('createComment (#1228)', () => {
  it('fails closed when there is no grant — never calls the API', async () => {
    noGrant();
    await expect(createComment(OWNER, REPO, 42, 'comment')).rejects.toThrow(/github_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when no PAT is sealed', async () => {
    grant(['github:write']);
    loadMock.mockResolvedValue(undefined);
    await expect(createComment(OWNER, REPO, 42, 'comment')).rejects.toThrow(/github_no_pat/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('posts to the correct GitHub API endpoint and returns the comment', async () => {
    grant(['github:write']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_COMMENT,
    });

    const result = await createComment(OWNER, REPO, 42, 'Test comment');

    expect(result).toMatchObject({ id: 999, html_url: MOCK_COMMENT.html_url });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${REPO}/issues/42/comments`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ body: 'Test comment' });
    expect(init.headers['Authorization']).toBe(`Bearer ${PAT}`);
  });

  it('publishes a github.comment.created bus event after a successful create', async () => {
    grant(['github:write']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_COMMENT,
    });

    await createComment(OWNER, REPO, 42, 'Test comment');

    expect(publishMock).toHaveBeenCalledOnce();
    const [eventType, payload] = publishMock.mock.calls[0];
    expect(eventType).toBe('github.comment.created');
    expect(payload.issuer).toBe(OWNER);
    expect(payload.payload.commentId).toBe(MOCK_COMMENT.id);
    expect(payload.payload.issueNumber).toBe(42);
  });

  it('does not throw when the bus publish fails (non-fatal)', async () => {
    grant(['github:write']);
    publishMock.mockRejectedValue(new Error('bus down'));
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_COMMENT,
    });

    await expect(createComment(OWNER, REPO, 42, 'comment')).resolves.toMatchObject({ id: 999 });
  });

  it('throws a descriptive error on a non-2xx GitHub API response', async () => {
    grant(['github:write']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      text: async () => 'Resource not accessible',
    });

    await expect(createComment(OWNER, REPO, 42, 'comment')).rejects.toThrow(/GitHub API error 403/);
  });
});

// ── listIssues ────────────────────────────────────────────────────────────────

describe('listIssues (#1228)', () => {
  it('fails closed when there is no grant — never calls the API', async () => {
    noGrant();
    await expect(listIssues(OWNER, REPO)).rejects.toThrow(/github_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when no PAT is sealed', async () => {
    grant(['github:read']);
    loadMock.mockResolvedValue(undefined);
    await expect(listIssues(OWNER, REPO)).rejects.toThrow(/github_no_pat/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches from the correct endpoint with the default open state', async () => {
    grant(['github:read']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [MOCK_ISSUE],
    });

    const issues = await listIssues(OWNER, REPO);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ number: 42, title: 'Test Issue' });
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain(`/repos/${REPO}/issues`);
    expect(url).toContain('state=open');
    expect(url).toContain('per_page=50');
  });

  it('passes the requested state filter through to the API', async () => {
    grant(['github:read']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [],
    });

    await listIssues(OWNER, REPO, 'closed');

    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('state=closed');
  });
});

// ── getIssue ──────────────────────────────────────────────────────────────────

describe('getIssue (#1228)', () => {
  it('fails closed when there is no grant — never calls the API', async () => {
    noGrant();
    await expect(getIssue(OWNER, REPO, 42)).rejects.toThrow(/github_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when no PAT is sealed', async () => {
    grant(['github:read']);
    loadMock.mockResolvedValue(undefined);
    await expect(getIssue(OWNER, REPO, 42)).rejects.toThrow(/github_no_pat/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches from the correct endpoint and returns the issue', async () => {
    grant(['github:read']);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_ISSUE,
    });

    const issue = await getIssue(OWNER, REPO, 42);

    expect(issue).toMatchObject({ number: 42, title: 'Test Issue', state: 'open' });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${REPO}/issues/42`);
    expect(init.method).toBe('GET');
    expect(init.headers['Authorization']).toBe(`Bearer ${PAT}`);
  });
});

// ── Security invariants ───────────────────────────────────────────────────────

describe('security invariants (#1228)', () => {
  it('GITHUB_CONNECTOR_DID is stable', () => {
    expect(GITHUB_CONNECTOR_DID).toBe('did:imajin:github-connector');
  });

  it('different DIDs have different vault fields (cross-DID isolation)', () => {
    const didA = 'did:imajin:alice';
    const didB = 'did:imajin:bob';
    const fieldA = vaultField(didA);
    const fieldB = vaultField(didB);
    expect(fieldA).not.toBe(fieldB);
    expect(fieldA).toBe(`github-pat:${didA}`);
    expect(fieldB).toBe(`github-pat:${didB}`);
  });
});
