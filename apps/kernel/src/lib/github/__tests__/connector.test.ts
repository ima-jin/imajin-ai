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
  oauthVaultField,
  configField,
  storeConfig,
  buildAuthorizeUrl,
  exchangeCodeAndStore,
  GITHUB_CONNECTOR_DID,
  GITHUB_OAUTH_SCOPE,
} from '../connector';

const OWNER = 'did:imajin:eric';
const REPO = 'a-r-t-i-f-a-c-t/artifactagent';
const PAT = 'ghp_REDACTED';
const CONFIG = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://imajin.test/github/api/callback' };

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

// Per-field vault responses. Default: no OAuth bundle / no config, so the PAT
// fallback path is exercised (keeping the #1228 assertions valid).
let oauthResponse: string | undefined;
let configResponse: string | undefined;

function setConfig(present = true) {
  configResponse = present ? JSON.stringify(CONFIG) : undefined;
}

function sealedOAuth(overrides: Record<string, unknown> = {}) {
  oauthResponse = JSON.stringify({ accessToken: 'gho_at', ...overrides });
}

beforeEach(() => {
  sealMock.mockReset();
  sealMock.mockResolvedValue(undefined);
  oauthResponse = undefined;
  configResponse = undefined;
  loadMock.mockReset();
  loadMock.mockImplementation((field: string) => {
    if (field.startsWith('github-oauth:')) return Promise.resolve(oauthResponse);
    if (field.startsWith('github-config:')) return Promise.resolve(configResponse);
    return Promise.resolve(PAT);
  });
  whereMock.mockReset();
  publishMock.mockReset();
  publishMock.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ΓöÇΓöÇ vaultField ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

describe('vaultField', () => {
  it('encodes the ownerDid in the field name for per-DID isolation', () => {
    expect(vaultField(OWNER)).toBe(`github-pat:${OWNER}`);
  });
});

// ΓöÇΓöÇ resolveActiveGrant ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

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

// ΓöÇΓöÇ sealPat ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

describe('sealPat (#1228)', () => {
  it('seals the PAT under the per-DID vault field', async () => {
    await sealPat(OWNER, PAT);
    expect(sealMock).toHaveBeenCalledOnce();
    const [field, plaintext] = sealMock.mock.calls[0];
    expect(field).toBe(vaultField(OWNER));
    expect(plaintext).toBe(PAT);
  });
});

// ΓöÇΓöÇ createIssue ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

describe('createIssue (#1228)', () => {
  it('fails closed when there is no grant ΓÇö never calls the API', async () => {
    noGrant();
    await expect(createIssue(OWNER, REPO, 'Title', 'Body')).rejects.toThrow(/github_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when no credential is sealed', async () => {
    grant(['github:write']);
    loadMock.mockResolvedValue(undefined);
    await expect(createIssue(OWNER, REPO, 'Title', 'Body')).rejects.toThrow(/github_no_credential/);
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

// ΓöÇΓöÇ createComment ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

describe('createComment (#1228)', () => {
  it('fails closed when there is no grant ΓÇö never calls the API', async () => {
    noGrant();
    await expect(createComment(OWNER, REPO, 42, 'comment')).rejects.toThrow(/github_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when no credential is sealed', async () => {
    grant(['github:write']);
    loadMock.mockResolvedValue(undefined);
    await expect(createComment(OWNER, REPO, 42, 'comment')).rejects.toThrow(/github_no_credential/);
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

// ΓöÇΓöÇ listIssues ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

describe('listIssues (#1228)', () => {
  it('fails closed when there is no grant ΓÇö never calls the API', async () => {
    noGrant();
    await expect(listIssues(OWNER, REPO)).rejects.toThrow(/github_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when no credential is sealed', async () => {
    grant(['github:read']);
    loadMock.mockResolvedValue(undefined);
    await expect(listIssues(OWNER, REPO)).rejects.toThrow(/github_no_credential/);
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

// ΓöÇΓöÇ getIssue ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

describe('getIssue (#1228)', () => {
  it('fails closed when there is no grant ΓÇö never calls the API', async () => {
    noGrant();
    await expect(getIssue(OWNER, REPO, 42)).rejects.toThrow(/github_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when no credential is sealed', async () => {
    grant(['github:read']);
    loadMock.mockResolvedValue(undefined);
    await expect(getIssue(OWNER, REPO, 42)).rejects.toThrow(/github_no_credential/);
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

// ΓöÇΓöÇ Security invariants ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ

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

  it('OAuth + config vault fields encode the ownerDid per-DID', () => {
    expect(oauthVaultField(OWNER)).toBe(`github-oauth:${OWNER}`);
    expect(configField(OWNER)).toBe(`github-config:${OWNER}`);
  });
});

// ── OAuth2 config + flows (#1333) ─────────────────────────────────────────

describe('storeConfig (#1333 per-DID OAuth app creds)', () => {
  it('seals the app config under the per-DID config field', async () => {
    await storeConfig(OWNER, CONFIG);
    expect(sealMock).toHaveBeenCalledOnce();
    const [field, blob] = sealMock.mock.calls[0];
    expect(field).toBe(configField(OWNER));
    expect(JSON.parse(blob as string)).toMatchObject({ clientId: 'cid', redirectUri: CONFIG.redirectUri });
  });
});

describe('buildAuthorizeUrl (#1333)', () => {
  it('includes client_id, redirect_uri, scope, and state (from per-DID config)', async () => {
    setConfig();
    const url = await buildAuthorizeUrl(OWNER, 'state123');
    expect(url).toContain('https://github.com/login/oauth/authorize');
    expect(url).toContain('client_id=cid');
    expect(url).toContain('state=state123');
    expect(url).toContain(`scope=${GITHUB_OAUTH_SCOPE}`);
    expect(url).toContain(encodeURIComponent(CONFIG.redirectUri));
  });
});

describe('exchangeCodeAndStore (#1333)', () => {
  it('exchanges the auth code and seals the token bundle per-DID', async () => {
    setConfig();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'gho_at', scope: 'repo', token_type: 'bearer' }),
    });

    await exchangeCodeAndStore(OWNER, 'code123');

    const oauthCall = sealMock.mock.calls.find(([field]) => field === oauthVaultField(OWNER));
    expect(oauthCall).toBeDefined();
    expect(JSON.parse(oauthCall![1] as string)).toMatchObject({ accessToken: 'gho_at', scope: 'repo' });

    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://github.com/login/oauth/access_token');
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
    const tokenBody = init.body as string;
    expect(tokenBody).toContain('grant_type=authorization_code');
    expect(tokenBody).toContain('client_id=cid');
    expect(tokenBody).toContain('client_secret=csecret');
  });

  it('throws when GitHub answers 200 with an error body', async () => {
    setConfig();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ error: 'bad_verification_code', error_description: 'expired' }),
    });
    await expect(exchangeCodeAndStore(OWNER, 'code123')).rejects.toThrow(/bad_verification_code/);
  });
});

describe('OAuth credential preference (#1333)', () => {
  it('uses the sealed OAuth access token instead of the PAT', async () => {
    grant(['github:read']);
    sealedOAuth(); // accessToken gho_at, non-expiring
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_ISSUE,
    });

    await getIssue(OWNER, REPO, 42);

    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers['Authorization']).toBe('Bearer gho_at');
  });

  it('refreshes an expired OAuth token before calling the API', async () => {
    grant(['github:read']);
    setConfig();
    sealedOAuth({ refreshToken: 'grt', expiresAt: Date.now() - 1000 });
    (fetch as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'gho_at2', refresh_token: 'grt2', expires_in: 28800, scope: 'repo' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => MOCK_ISSUE });

    await getIssue(OWNER, REPO, 42);

    // First fetch is the refresh; second is the API call with the fresh token.
    const refreshBody = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string;
    expect(refreshBody).toContain('grant_type=refresh_token');
    const apiInit = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1];
    expect(apiInit.headers['Authorization']).toBe('Bearer gho_at2');
    // Refreshed bundle re-sealed at the OAuth field.
    expect(sealMock.mock.calls.some(([field]) => field === oauthVaultField(OWNER))).toBe(true);
  });

  it('does not refresh a non-expiring OAuth token (no refresh token)', async () => {
    grant(['github:read']);
    sealedOAuth(); // no refreshToken, no expiresAt
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_ISSUE,
    });

    await getIssue(OWNER, REPO, 42);

    // Only the API call happened — no token-endpoint refresh.
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${REPO}/issues/42`);
  });
});
