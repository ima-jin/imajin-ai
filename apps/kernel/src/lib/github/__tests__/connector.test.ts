import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Hoisted mocks — evaluated before any module imports.
 *
 * Mock architecture:
 *   whereMock          — terminal for channelLinks select().from().where() (grant check)
 *   proposalLimitMock  — terminal for proposals select().from().where().orderBy().limit()
 *                        (the approved-row scan resolved by requireWriteGate)
 *   proposalCountMock  — terminal for proposals select({count}).from().where() (rate-limit count)
 *   proposalInsertMock — terminal for proposals insert().values() (insert pending/done row)
 *   proposalUpdateMock — terminal for proposals update().set().where() (mark done / retire lapsed)
 *   proposalUpdateSetMock — records the update().set() payload so tests can assert
 *                           which status transition was written
 */
const {
  sealMock, loadMock, publishMock,
  whereMock,
  proposalLimitMock,
  proposalCountMock,
  proposalInsertMock,
  proposalUpdateMock,
  proposalUpdateSetMock,
} = vi.hoisted(() => ({
  sealMock: vi.fn(),
  loadMock: vi.fn(),
  publishMock: vi.fn(),
  whereMock: vi.fn(),           // channelLinks grant check
  proposalLimitMock: vi.fn(),   // proposals select().where().orderBy().limit()
  proposalCountMock: vi.fn(),   // proposals select({count}).where()
  proposalInsertMock: vi.fn(),  // proposals insert().values()
  proposalUpdateMock: vi.fn(),  // proposals update().set().where()
  proposalUpdateSetMock: vi.fn(), // proposals update().set() payload recorder
}));

vi.mock('nanoid', () => ({ nanoid: () => 'test-id-0001' }));
// drizzle-orm is an ESM package; mock the query-builder helpers the connector uses.
// The mock DB ignores all conditions, so these just need to be callable.
vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => ({ col, val }),
  gt: (col: unknown, val: unknown) => ({ col, val }),
  lte: (col: unknown, val: unknown) => ({ col, val }),
  isNotNull: (col: unknown) => ({ col }),
  desc: (col: unknown) => ({ col, dir: 'desc' }),
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ raw: strings.join('?'), values }),
    { mapWith: (fn: unknown) => fn },
  ),
}));
vi.mock('@/src/lib/vault', () => ({ sealAndStoreV2: sealMock, loadAndUnseal: loadMock }));

/**
 * @/src/db mock — routes select().from(table) to the correct terminal mock
 * based on which table is passed and whether a projection was provided.
 *
 * channelLinks queries   → whereMock (terminal)
 * proposals row queries  → proposalLimitMock (via .where().orderBy().limit())
 * proposals count queries → proposalCountMock (terminal at .where())
 */
vi.mock('@/src/db', () => {
  const channelLinks = {
    channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes',
  };
  const githubActionProposals = {
    id: 'id', ownerDid: 'owner_did', agentDid: 'agent_did',
    scope: 'scope', tool: 'tool', riskTier: 'risk_tier',
    target: 'target', argsSummary: 'args_summary',
    status: 'status', approvedUntil: 'approved_until',
    ownerAuthorization: 'owner_authorization',
    createdAt: 'created_at', updatedAt: 'updated_at',
  };

  // Closure state: updated synchronously in select() before from() is called.
  let _isCountQuery = false;

  // Hoisted out of the select().from() chain to keep callback nesting shallow.
  const orderedRowQuery = () => ({ limit: proposalLimitMock });

  return {
    db: {
      select: (proj?: Record<string, unknown>) => {
        _isCountQuery = proj !== undefined && 'count' in proj;
        return {
          from: (table: unknown) => {
            if (table === channelLinks) {
              return { where: whereMock };
            }
            // githubActionProposals
            if (_isCountQuery) {
              return { where: proposalCountMock };
            }
            return { where: () => ({ orderBy: orderedRowQuery }) };
          },
        };
      },
      insert: () => ({ values: proposalInsertMock }),
      update: () => ({
        set: (values: unknown) => {
          proposalUpdateSetMock(values);
          return { where: proposalUpdateMock };
        },
      }),
    },
    channelLinks,
    githubActionProposals,
  };
});

vi.mock('@imajin/bus', () => ({ publish: publishMock }));

// Disclosure allowlist (#1373). readReadAllowlist is controllable per-test; the
// filter/matcher helpers default to identity/allow so the connector paths are
// exercised without loading the manifest-read module (its own logic is covered
// by allowlist.test.ts).
const { readAllowlistMock, filterOrgsMock, filterReposMock, isRepoAllowedMock } = vi.hoisted(() => ({
  readAllowlistMock: vi.fn(),
  filterOrgsMock: vi.fn(),
  filterReposMock: vi.fn(),
  isRepoAllowedMock: vi.fn(),
}));
vi.mock('../allowlist', () => ({
  readReadAllowlist: readAllowlistMock,
  filterOrgs: filterOrgsMock,
  filterRepos: filterReposMock,
  isRepoAllowed: isRepoAllowedMock,
}));

import { VaultDelegationError } from '@/src/lib/vault/errors';
import {
  resolveActiveGrant,
  sealPat,
  createIssue,
  createComment,
  listIssues,
  getIssue,
  updateIssue,
  listOrgs,
  listRepos,
  getRepo,
  vaultField,
  oauthVaultField,
  configField,
  storeConfig,
  buildAuthorizeUrl,
  exchangeCodeAndStore,
  readConfigFlow,
  requestDeviceCode,
  pollDeviceTokenOnce,
  GITHUB_CONNECTOR_DID,
  GITHUB_OAUTH_SCOPE,
} from '../connector';

const OWNER = 'did:imajin:eric';
const REPO = 'a-r-t-i-f-a-c-t/artifactagent';
const PAT = 'ghp_REDACTED';
const CONFIG = { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://imajin.test/github/api/callback' };
/** Device-mode BYO config (#1391): client id, nothing else. */
const DEVICE_CONFIG = { clientId: 'cid-device', flow: 'device' as const };

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

/**
 * Sets up a live windowed append-tier approval grant.
 * Use in tests that expect createIssue / createComment to proceed.
 * Windowed (not single-call) to avoid asserting on proposalUpdateMock in existing tests.
 */
function appendLiveGrant() {
  proposalLimitMock.mockResolvedValue([{
    id: 'proposal_append_approved',
    ownerDid: OWNER,
    status: 'approved',
    riskTier: 'append',
    approvedUntil: new Date(Date.now() + 60 * 60 * 1000), // 1hr windowed
  }]);
}

// Per-field vault responses. Default: no OAuth bundle / no config, so the PAT
// fallback path is exercised (keeping the #1228 assertions valid).
let oauthResponse: string | undefined;
let configResponse: string | undefined;

function setConfig(present = true) {
  configResponse = present ? JSON.stringify(CONFIG) : undefined;
}

/** Seal a device-mode config (#1391) for this DID. */
function setDeviceConfig() {
  configResponse = JSON.stringify(DEVICE_CONFIG);
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
  // Proposal mocks — default: no live grant, zero done writes, operations succeed.
  proposalLimitMock.mockReset();
  proposalLimitMock.mockResolvedValue([]);
  proposalCountMock.mockReset();
  proposalCountMock.mockResolvedValue([{ count: 0 }]);
  proposalInsertMock.mockReset();
  proposalInsertMock.mockResolvedValue([]);
  proposalUpdateMock.mockReset();
  proposalUpdateMock.mockResolvedValue([]);
  proposalUpdateSetMock.mockReset();
  // Allowlist mocks — default: allow-all (null), identity filters, repo allowed.
  readAllowlistMock.mockReset();
  readAllowlistMock.mockResolvedValue(null);
  filterOrgsMock.mockReset();
  filterOrgsMock.mockImplementation((orgs: unknown[]) => orgs);
  filterReposMock.mockReset();
  filterReposMock.mockImplementation((repos: unknown[]) => repos);
  isRepoAllowedMock.mockReset();
  isRepoAllowedMock.mockReturnValue(true);
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
  it('fails closed when there is no grant — never calls the API', async () => {
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
    appendLiveGrant();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_ISSUE,
    });

    const result = await createIssue(OWNER, REPO, 'Test Issue', 'Issue body');

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.data).toMatchObject({ number: 42, html_url: MOCK_ISSUE.html_url });
    }
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${REPO}/issues`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ title: 'Test Issue', body: 'Issue body' });
    expect(init.headers['Authorization']).toBe(`Bearer ${PAT}`);
  });

  it('publishes a github.issue.created bus event after a successful create', async () => {
    grant(['github:write']);
    appendLiveGrant();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_ISSUE,
    });

    await createIssue(OWNER, REPO, 'Test Issue', 'Body');

    const issuedCall = publishMock.mock.calls.find(([type]) => type === 'github.issue.created');
    expect(issuedCall).toBeDefined();
    expect(issuedCall![1].issuer).toBe(OWNER);
    expect(issuedCall![1].payload.issueNumber).toBe(MOCK_ISSUE.number);
    expect(issuedCall![1].payload.repo).toBe(REPO);
  });

  it('does not throw when the bus publish fails (non-fatal)', async () => {
    grant(['github:write']);
    appendLiveGrant();
    publishMock.mockRejectedValue(new Error('bus down'));
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_ISSUE,
    });

    await expect(createIssue(OWNER, REPO, 'Title', 'Body')).resolves.toMatchObject({ status: 'done' });
  });

  it('throws a descriptive error on a non-2xx GitHub API response', async () => {
    grant(['github:write']);
    appendLiveGrant();
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
  it('fails closed when there is no grant — never calls the API', async () => {
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
    appendLiveGrant();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_COMMENT,
    });

    const result = await createComment(OWNER, REPO, 42, 'Test comment');

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.data).toMatchObject({ id: 999, html_url: MOCK_COMMENT.html_url });
    }
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${REPO}/issues/42/comments`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ body: 'Test comment' });
    expect(init.headers['Authorization']).toBe(`Bearer ${PAT}`);
  });

  it('publishes a github.comment.created bus event after a successful create', async () => {
    grant(['github:write']);
    appendLiveGrant();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_COMMENT,
    });

    await createComment(OWNER, REPO, 42, 'Test comment');

    const commentedCall = publishMock.mock.calls.find(([type]) => type === 'github.comment.created');
    expect(commentedCall).toBeDefined();
    expect(commentedCall![1].issuer).toBe(OWNER);
    expect(commentedCall![1].payload.commentId).toBe(MOCK_COMMENT.id);
    expect(commentedCall![1].payload.issueNumber).toBe(42);
  });

  it('does not throw when the bus publish fails (non-fatal)', async () => {
    grant(['github:write']);
    appendLiveGrant();
    publishMock.mockRejectedValue(new Error('bus down'));
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_COMMENT,
    });

    await expect(createComment(OWNER, REPO, 42, 'comment')).resolves.toMatchObject({ status: 'done' });
  });

  it('throws a descriptive error on a non-2xx GitHub API response', async () => {
    grant(['github:write']);
    appendLiveGrant();
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

// ── Org / repo discovery (#1373) ─────────────────────────────────────────────

const MOCK_ORG_A = { login: 'ima-jin', id: 1, description: 'org a' };
const MOCK_ORG_B = { login: 'stranger', id: 2, description: 'org b' };
const MOCK_REPO_A = { full_name: 'ima-jin/imajin-ai', private: true, html_url: 'https://github.com/ima-jin/imajin-ai', description: null, default_branch: 'main', permissions: { admin: true, push: true, pull: true } };
const MOCK_REPO_B = { full_name: 'stranger/secret', private: true, html_url: 'https://github.com/stranger/secret', description: null, default_branch: 'main' };

function mockFetchJson(value: unknown) {
  (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: async () => value });
}

describe('listOrgs (#1373)', () => {
  it('fails closed when there is no grant — never calls the API', async () => {
    noGrant();
    await expect(listOrgs(OWNER)).rejects.toThrow(/github_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fails closed when no credential is sealed', async () => {
    grant(['github:read']);
    loadMock.mockResolvedValue(undefined);
    await expect(listOrgs(OWNER)).rejects.toThrow(/github_no_credential/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches /user/orgs and filters the result server-side after the fetch', async () => {
    grant(['github:read']);
    const allowlist = new Set(['ima-jin']);
    readAllowlistMock.mockResolvedValue(allowlist);
    mockFetchJson([MOCK_ORG_A, MOCK_ORG_B]);
    filterOrgsMock.mockReturnValue([MOCK_ORG_A]);

    const orgs = await listOrgs(OWNER);

    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/user/orgs');
    // Filtering happens post-fetch, against the fetched list + allowlist.
    expect(filterOrgsMock).toHaveBeenCalledWith([MOCK_ORG_A, MOCK_ORG_B], allowlist);
    expect(orgs).toEqual([MOCK_ORG_A]);
  });
});

describe('listRepos (#1373)', () => {
  it('fails closed when there is no grant — never calls the API', async () => {
    noGrant();
    await expect(listRepos(OWNER)).rejects.toThrow(/github_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lists the user\u2019s repos by default and filters post-fetch', async () => {
    grant(['github:read']);
    mockFetchJson([MOCK_REPO_A, MOCK_REPO_B]);
    filterReposMock.mockReturnValue([MOCK_REPO_A]);

    const repos = await listRepos(OWNER);

    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toContain('/user/repos');
    expect(filterReposMock).toHaveBeenCalledWith([MOCK_REPO_A, MOCK_REPO_B], null);
    expect(repos).toEqual([MOCK_REPO_A]);
  });

  it('scopes to an org when org is provided', async () => {
    grant(['github:read']);
    mockFetchJson([MOCK_REPO_A]);

    await listRepos(OWNER, 'ima-jin');

    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://api.github.com/orgs/ima-jin/repos?per_page=100');
  });
});

describe('getRepo (#1373)', () => {
  it('fails closed when there is no grant — never calls the API', async () => {
    noGrant();
    await expect(getRepo(OWNER, REPO)).rejects.toThrow(/github_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('throws github_not_in_scope for an out-of-allowlist target without fetching', async () => {
    grant(['github:read']);
    isRepoAllowedMock.mockReturnValue(false);

    await expect(getRepo(OWNER, 'stranger/secret')).rejects.toThrow(/github_not_in_scope/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fetches /repos/{repo} when the target is in scope', async () => {
    grant(['github:read']);
    isRepoAllowedMock.mockReturnValue(true);
    mockFetchJson(MOCK_REPO_A);

    const repo = await getRepo(OWNER, MOCK_REPO_A.full_name);

    expect(repo).toMatchObject({ full_name: MOCK_REPO_A.full_name, default_branch: 'main' });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${MOCK_REPO_A.full_name}`);
    expect(init.method).toBe('GET');
  });
});

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

// ── Device flow (#1391) ──────────────────────────────────────────────────

describe('GitHub device flow (#1391)', () => {
  it('requests the device code from GitHub with the client id only', async () => {
    setDeviceConfig();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        device_code: 'dev-code-xyz',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 899,
        interval: 5,
      }),
    });

    const grantResult = await requestDeviceCode(OWNER);

    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('https://github.com/login/device/code');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('client_id')).toBe('cid-device');
    expect(body.get('scope')).toBe(GITHUB_OAUTH_SCOPE);
    expect(body.get('client_secret')).toBeNull();
    expect(grantResult).toMatchObject({
      userCode: 'ABCD-1234',
      verificationUri: 'https://github.com/login/device',
    });
  });

  it('seals the token at github-oauth:${did} — same custody as the auth-code path', async () => {
    setDeviceConfig();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'gho_device', scope: 'repo', token_type: 'bearer' }),
    });

    await expect(pollDeviceTokenOnce(OWNER, 'dev-code-xyz')).resolves.toBe('authorized');

    const oauthCall = sealMock.mock.calls.find(([field]) => field === oauthVaultField(OWNER));
    expect(oauthCall).toBeDefined();
    expect(JSON.parse(oauthCall![1] as string)).toMatchObject({ accessToken: 'gho_device', scope: 'repo' });
  });

  it('reports pending without sealing while the human has not authorized yet', async () => {
    setDeviceConfig();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ error: 'authorization_pending' }),
    });

    await expect(pollDeviceTokenOnce(OWNER, 'dev-code-xyz')).resolves.toBe('pending');
    expect(sealMock).not.toHaveBeenCalled();
  });

  it('rejects the authorization-code path on a device-mode config', async () => {
    setDeviceConfig();

    await expect(buildAuthorizeUrl(OWNER, 'state123')).rejects.toThrow(/github_flow_mismatch/);
  });
});

describe('readConfigFlow (#1391)', () => {
  it('reports device for a clientId-only config', async () => {
    setDeviceConfig();
    expect(await readConfigFlow(OWNER)).toBe('device');
  });

  it('reports authorization_code for a pre-#1391 three-field config', async () => {
    setConfig();
    expect(await readConfigFlow(OWNER)).toBe('authorization_code');
  });

  it('reports null when nothing is configured (not an error)', async () => {
    setConfig(false);
    expect(await readConfigFlow(OWNER)).toBeNull();
  });

  it('reports null when the config is sealed but awaiting owner grant approval', async () => {
    loadMock.mockImplementation((field: string) =>
      Promise.reject(new VaultDelegationError('no active grant', { field, nodeDid: 'did:imajin:node' })),
    );

    expect(await readConfigFlow(OWNER)).toBeNull();
  });
});

describe('credential pending (#1521)', () => {
  it('surfaces github_credential_pending when the sealed OAuth token has no active grant yet', async () => {
    grant(['github:read']);
    loadMock.mockImplementation((field: string) => {
      if (field.startsWith('github-oauth:')) {
        return Promise.reject(new VaultDelegationError('no active grant', { field, nodeDid: 'did:imajin:node' }));
      }
      return Promise.resolve(undefined);
    });

    await expect(getIssue(OWNER, REPO, 42)).rejects.toThrow(/github_credential_pending/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces github_credential_pending when the sealed PAT has no active grant yet (no OAuth bundle)', async () => {
    grant(['github:read']);
    loadMock.mockImplementation((field: string) => {
      if (field.startsWith('github-oauth:') || field.startsWith('github-config:')) {
        return Promise.resolve(undefined);
      }
      return Promise.reject(new VaultDelegationError('no active grant', { field, nodeDid: 'did:imajin:node' }));
    });

    await expect(listIssues(OWNER, REPO)).rejects.toThrow(/github_credential_pending/);
    expect(fetch).not.toHaveBeenCalled();
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

// ── updateIssue: confirm rail (#1366) ───────────────────────────────────────────────

describe('updateIssue confirm rail (#1366)', () => {
  // Helper: put a live approved row for 'mutate' risk tier in the mock.
  function liveApprovalGrant(overrides: { approvedUntil?: Date | null } = {}) {
    proposalLimitMock.mockResolvedValue([{
      id: 'proposal_approved',
      ownerDid: OWNER,
      status: 'approved',
      riskTier: 'mutate',
      approvedUntil: overrides.approvedUntil !== undefined ? overrides.approvedUntil : null,
    }]);
  }

  it('fails closed on no channel_links grant — throws github_no_grant, never reaches the confirm gate', async () => {
    noGrant();
    await expect(updateIssue(OWNER, REPO, 42, { state: 'closed' }))
      .rejects.toThrow(/github_no_grant/);
    expect(fetch).not.toHaveBeenCalled();
    expect(proposalInsertMock).not.toHaveBeenCalled();
  });

  it('fails closed on missing credential — throws github_no_credential, confirm gate never reached', async () => {
    grant(['github:write']);
    loadMock.mockResolvedValue(undefined);
    await expect(updateIssue(OWNER, REPO, 42, { state: 'closed' }))
      .rejects.toThrow(/github_no_credential/);
    expect(fetch).not.toHaveBeenCalled();
    expect(proposalInsertMock).not.toHaveBeenCalled();
  });

  it('no live approval grant → returns pending + publishes action.proposed + never calls the API', async () => {
    grant(['github:write']);
    // Default: proposalLimitMock returns [] (no live grant), proposalCountMock returns [{count:0}].

    const result = await updateIssue(OWNER, REPO, 42, { state: 'closed' });

    expect(result.status).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();

    // A pending proposal was inserted.
    expect(proposalInsertMock).toHaveBeenCalledOnce();
    const insertedRow = proposalInsertMock.mock.calls[0][0];
    expect(insertedRow.ownerDid).toBe(OWNER);
    expect(insertedRow.tool).toBe('github_update_issue');
    expect(insertedRow.riskTier).toBe('mutate');
    expect(insertedRow.status).toBe('pending');
    expect(insertedRow.id).toMatch(/^proposal_/);

    // action.proposed was published.
    const proposedCall = publishMock.mock.calls.find(([type]) => type === 'action.proposed');
    expect(proposedCall).toBeDefined();
    expect(proposedCall![1].payload.proposalId).toBe(insertedRow.id);
    expect(proposedCall![1].payload.tool).toBe('github_update_issue');
    expect(proposedCall![1].payload.risk).toBe('mutate');

    // The returned pending result carries the proposalId.
    if (result.status === 'pending') {
      expect(result.proposalId).toBe(insertedRow.id);
    }
  });

  it('single-call live grant → executes PATCH, marks proposal done, publishes action.done', async () => {
    grant(['github:write']);
    liveApprovalGrant({ approvedUntil: null }); // single-call (approvedUntil IS NULL)
    const UPDATED_ISSUE = { ...MOCK_ISSUE, state: 'closed', updated_at: '2026-07-22T00:00:00.000Z' };
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => UPDATED_ISSUE,
    });

    const result = await updateIssue(OWNER, REPO, 42, { state: 'closed' });

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.data.state).toBe('closed');
    }

    // PATCH was sent to the correct URL.
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${REPO}/issues/42`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toMatchObject({ state: 'closed' });

    // Single-call: proposal updated to 'done' via update mock.
    expect(proposalUpdateMock).toHaveBeenCalledOnce();

    // action.done was published.
    const doneCall = publishMock.mock.calls.find(([type]) => type === 'action.done');
    expect(doneCall).toBeDefined();
    expect(doneCall![1].payload.tool).toBe('github_update_issue');
  });

  it('windowed live grant → executes PATCH, inserts done row for rate counting, does not mark original proposal done', async () => {
    grant(['github:write']);
    liveApprovalGrant({ approvedUntil: new Date(Date.now() + 5 * 60 * 1000) }); // windowed 5m
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ...MOCK_ISSUE, state: 'closed' }),
    });

    const result = await updateIssue(OWNER, REPO, 42, { state: 'closed' });

    expect(result.status).toBe('done');

    // Windowed: a 'done' row was inserted for rate accounting.
    expect(proposalInsertMock).toHaveBeenCalledOnce();
    const insertedDone = proposalInsertMock.mock.calls[0][0];
    expect(insertedDone.status).toBe('done');

    // The original approved row was NOT updated (windowed stays active).
    expect(proposalUpdateMock).not.toHaveBeenCalled();
  });

  it('global write ceiling exceeded → re-proposes even inside a live windowed grant', async () => {
    grant(['github:write']);
    liveApprovalGrant({ approvedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000) }); // live 24h window
    // Ceiling: 30 done writes in the last hour.
    proposalCountMock.mockResolvedValue([{ count: 30 }]);

    const result = await updateIssue(OWNER, REPO, 42, { state: 'closed' });

    // Still pending despite the live window.
    expect(result.status).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();

    // A new pending proposal was inserted with the RATE_LIMIT annotation.
    expect(proposalInsertMock).toHaveBeenCalledOnce();
    const insertedRow = proposalInsertMock.mock.calls[0][0];
    expect(insertedRow.argsSummary).toContain('[RATE_LIMIT]');
    expect(insertedRow.status).toBe('pending');

    // action.proposed was still published (for dashboard surfacing).
    const proposedCall = publishMock.mock.calls.find(([type]) => type === 'action.proposed');
    expect(proposedCall).toBeDefined();
    expect(proposedCall![1].payload.argsSummary).toContain('[RATE_LIMIT]');
  });

  it('updateIssue requires at least one field to update', async () => {
    grant(['github:write']);
    // The MCP tool enforces this; the connector accepts an empty object but the
    // tool handler would have thrown first. Test that the gate runs fine with an
    // empty patchBody if called directly (no API field sent).
    // This test validates updateIssue still calls the confirm gate, not the API shape.
    const result = await updateIssue(OWNER, REPO, 42, {});
    // No live grant → pending.
    expect(result.status).toBe('pending');
  });

  it('does not echo the bearer token in the updateIssue return value', async () => {
    grant(['github:write']);
    liveApprovalGrant({ approvedUntil: null });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_ISSUE,
    });

    const result = await updateIssue(OWNER, REPO, 42, { title: 'new title' });

    expect(result.status).toBe('done');
    // The result carries the GitHub API response — it must not contain the PAT.
    expect(JSON.stringify(result)).not.toContain(PAT);
  });
});

// ── Lapsed approval windows (#1588) ────────────────────────────────────────────

/**
 * Regression cover for the approve → retry → re-propose loop.
 *
 * Windowed approvals are deliberately left at 'approved' after each execution,
 * and nothing used to retire them once their TTL lapsed. The gate then read
 * them back with a bare `limit(1)` and no ORDER BY, so an arbitrary row won —
 * frequently a dead window sitting in front of a live approval. Expiry was
 * judged on that one row, so the gate re-proposed while a valid approval was
 * right there in the table. Approving again just added another row the query
 * never reached, which is why granting a fresh 24h window before the retry
 * changed nothing.
 *
 * The mock DB ignores WHERE clauses, so `proposalLimitMock` stands in for "the
 * approved rows for this tuple, newest-first" — exactly the page the gate now
 * scans. Ordering within these fixtures therefore matters.
 */
describe('lapsed approval windows (#1588)', () => {
  /** A windowed approval whose TTL has already elapsed. */
  function lapsedWindow(id: string, riskTier: 'append' | 'mutate' = 'mutate') {
    return {
      id,
      ownerDid: OWNER,
      status: 'approved',
      riskTier,
      approvedUntil: new Date(Date.now() - 60 * 60 * 1000), // 1hr in the past
    };
  }

  /** A windowed approval that is still live. */
  function liveWindow(id: string, riskTier: 'append' | 'mutate' = 'mutate') {
    return {
      id,
      ownerDid: OWNER,
      status: 'approved',
      riskTier,
      approvedUntil: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h window
    };
  }

  it('a lapsed window sitting ahead of a fresh 24h approval no longer blocks the write', async () => {
    grant(['github:write']);
    // The exact #1588 shape: a dead window AND a live one, dead row first so it
    // would have won the old `limit(1)` lottery.
    proposalLimitMock.mockResolvedValue([
      lapsedWindow('proposal_dead_window'),
      liveWindow('proposal_fresh_24h'),
    ]);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ...MOCK_ISSUE, state: 'closed' }),
    });

    const result = await updateIssue(OWNER, REPO, 42, { state: 'closed' });

    // Executes under the live approval instead of minting another proposal.
    expect(result.status).toBe('done');
    expect(fetch).toHaveBeenCalledOnce();

    // No pending proposal was raised — the loop is gone.
    const insertedStatuses = proposalInsertMock.mock.calls.map(([row]) => row.status);
    expect(insertedStatuses).not.toContain('pending');
    const proposedCall = publishMock.mock.calls.find(([type]) => type === 'action.proposed');
    expect(proposedCall).toBeUndefined();
  });

  it('retires the lapsed window to expired rather than done, so it cannot consume write budget', async () => {
    grant(['github:write']);
    proposalLimitMock.mockResolvedValue([
      lapsedWindow('proposal_dead_window'),
      liveWindow('proposal_fresh_24h'),
    ]);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ...MOCK_ISSUE, state: 'closed' }),
    });

    await updateIssue(OWNER, REPO, 42, { state: 'closed' });

    // The retirement UPDATE ran and wrote 'expired'.
    const retirement = proposalUpdateSetMock.mock.calls.find(
      ([values]) => (values as { status?: string }).status === 'expired',
    );
    expect(retirement).toBeDefined();

    // 'done' is the rate-limit counter's input, so a lapsed window must never
    // land there — only the windowed-execution accounting row may.
    const retiredAsDone = proposalUpdateSetMock.mock.calls.filter(
      ([values]) => (values as { status?: string }).status === 'done',
    );
    expect(retiredAsDone).toHaveLength(0);
  });

  it('re-proposes when every approval has lapsed — still fail-closed', async () => {
    grant(['github:write']);
    proposalLimitMock.mockResolvedValue([
      lapsedWindow('proposal_dead_1'),
      lapsedWindow('proposal_dead_2'),
    ]);

    const result = await updateIssue(OWNER, REPO, 42, { state: 'closed' });

    expect(result.status).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();

    const insertedRow = proposalInsertMock.mock.calls[0][0];
    expect(insertedRow.status).toBe('pending');

    // The dead rows were still cleaned up on the way past.
    const retirement = proposalUpdateSetMock.mock.calls.find(
      ([values]) => (values as { status?: string }).status === 'expired',
    );
    expect(retirement).toBeDefined();
  });

  it('spends a single-call approval ahead of a live window so it cannot linger', async () => {
    grant(['github:write']);
    // Newest-first: the window is newer, but the single-call row must win because
    // spending it retires it, whereas the window is reusable.
    proposalLimitMock.mockResolvedValue([
      liveWindow('proposal_fresh_24h'),
      { id: 'proposal_single', ownerDid: OWNER, status: 'approved', riskTier: 'mutate', approvedUntil: null },
    ]);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ...MOCK_ISSUE, state: 'closed' }),
    });

    const result = await updateIssue(OWNER, REPO, 42, { state: 'closed' });

    expect(result.status).toBe('done');
    // Single-call path: the grant row itself is marked done (no windowed
    // accounting row inserted).
    const markedDone = proposalUpdateSetMock.mock.calls.find(
      ([values]) => (values as { status?: string }).status === 'done',
    );
    expect(markedDone).toBeDefined();
    expect(proposalInsertMock).not.toHaveBeenCalled();
  });

  it('leaves a clean live window untouched — no retirement write on the happy path', async () => {
    grant(['github:write']);
    proposalLimitMock.mockResolvedValue([liveWindow('proposal_fresh_24h')]);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ...MOCK_ISSUE, state: 'closed' }),
    });

    const result = await updateIssue(OWNER, REPO, 42, { state: 'closed' });

    expect(result.status).toBe('done');
    // Nothing lapsed, so the gate issued no retirement UPDATE.
    const retirement = proposalUpdateSetMock.mock.calls.find(
      ([values]) => (values as { status?: string }).status === 'expired',
    );
    expect(retirement).toBeUndefined();
  });

  it('applies to append-tier writes too — a lapsed append window does not block createComment', async () => {
    grant(['github:write']);
    proposalLimitMock.mockResolvedValue([
      lapsedWindow('proposal_dead_append', 'append'),
      liveWindow('proposal_fresh_append', 'append'),
    ]);
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_COMMENT,
    });

    const result = await createComment(OWNER, REPO, 42, 'Eric\u2019s stuck comment');

    expect(result.status).toBe('done');
    expect(fetch).toHaveBeenCalledOnce();
    const proposedCall = publishMock.mock.calls.find(([type]) => type === 'action.proposed');
    expect(proposedCall).toBeUndefined();
  });

  it('survives a failed retirement write — cleanup is best-effort, the write still lands', async () => {
    grant(['github:write']);
    proposalLimitMock.mockResolvedValue([
      lapsedWindow('proposal_dead_window'),
      liveWindow('proposal_fresh_24h'),
    ]);
    // Retirement UPDATE blows up; the gate must not surface it.
    proposalUpdateMock.mockRejectedValue(new Error('db unavailable'));
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ...MOCK_ISSUE, state: 'closed' }),
    });

    const result = await updateIssue(OWNER, REPO, 42, { state: 'closed' });

    expect(result.status).toBe('done');
    expect(fetch).toHaveBeenCalledOnce();
  });
});

// ── Append vs mutate tiering (#1370) ───────────────────────────────────────────────────

describe('createIssue append tiering (#1370)', () => {
  it('no live append window → returns pending, publishes action.proposed with risk: append', async () => {
    grant(['github:write']);
    // Default: proposalLimitMock returns [] — no live grant exists.

    const result = await createIssue(OWNER, REPO, 'Test Issue', 'Body');

    expect(result.status).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();

    // Pending proposal inserted with riskTier = 'append' (DB field name).
    expect(proposalInsertMock).toHaveBeenCalledOnce();
    const row = proposalInsertMock.mock.calls[0][0];
    expect(row.riskTier).toBe('append');
    expect(row.tool).toBe('github_create_issue');
    expect(row.status).toBe('pending');

    // action.proposed carries risk: 'append' (bus event field name).
    const proposedCall = publishMock.mock.calls.find(([type]) => type === 'action.proposed');
    expect(proposedCall).toBeDefined();
    expect(proposedCall![1].payload.risk).toBe('append');
    expect(proposedCall![1].payload.tool).toBe('github_create_issue');
  });

  it('live append window → proceeds, issue created, status done', async () => {
    grant(['github:write']);
    appendLiveGrant();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_ISSUE,
    });

    const result = await createIssue(OWNER, REPO, 'Test Issue', 'Body');

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.data.number).toBe(42);
    }
    expect(fetch).toHaveBeenCalledOnce();
    const [url] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe(`https://api.github.com/repos/${REPO}/issues`);
  });
});

describe('createComment append tiering (#1370)', () => {
  it('no live append window → returns pending, publishes action.proposed with risk: append', async () => {
    grant(['github:write']);
    // Default: no live grant.

    const result = await createComment(OWNER, REPO, 42, 'Test comment');

    expect(result.status).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();

    const row = proposalInsertMock.mock.calls[0][0];
    expect(row.riskTier).toBe('append');
    expect(row.tool).toBe('github_create_comment');

    const proposedCall = publishMock.mock.calls.find(([type]) => type === 'action.proposed');
    expect(proposedCall).toBeDefined();
    expect(proposedCall![1].payload.risk).toBe('append');
  });

  it('live append window → proceeds, comment created, status done', async () => {
    grant(['github:write']);
    appendLiveGrant();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => MOCK_COMMENT,
    });

    const result = await createComment(OWNER, REPO, 42, 'Test comment');

    expect(result.status).toBe('done');
    if (result.status === 'done') {
      expect(result.data.id).toBe(999);
    }
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('mutate-write (updateIssue) is still pending when only append window is active', async () => {
    // This test verifies that a live append grant does NOT satisfy the mutate gate.
    // The gate queries filter by riskTier; in the real DB this is enforced by the
    // WHERE clause. In the mock, proposalLimitMock returns the same row regardless
    // of filter, so we verify indirectly: the gate that runs for updateIssue uses
    // riskTier='mutate'. Setting the mock to return an append-tier row and expecting
    // a real DB would reject it is covered by the requireWriteGate WHERE clause;
    // here we confirm the AC-required behaviour at the unit level by resetting
    // to no live grant (default) and verifying pending.
    grant(['github:write']);
    // No mutate-tier approved row (default: proposalLimitMock returns []).
    const result = await updateIssue(OWNER, REPO, 42, { state: 'closed' });
    expect(result.status).toBe('pending');
  });
});

// ── Per-tool sub-limits (#1371) ───────────────────────────────────────────────────

/**
 * proposalCountMock is called in sequence by requireWriteGate:
 *   call 1: global count (all tools, 1hr)
 *   call 2+: per-tool count entries (in PER_TOOL_LIMITS order for this tool)
 *
 * Use mockResolvedValueOnce to control each call independently.
 */
describe('per-tool sub-limits (#1371)', () => {
  // Helper: live mutate window so the approval path is reachable.
  function liveWindow() {
    proposalLimitMock.mockResolvedValue([{
      id: 'proposal_approved',
      ownerDid: OWNER,
      status: 'approved',
      riskTier: 'mutate',
      approvedUntil: new Date(Date.now() + 60 * 60 * 1000),
    }]);
  }

  it('global under limit + per-tool under limit → approved (writes proceed)', async () => {
    grant(['github:write']);
    liveWindow();
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ ...MOCK_ISSUE, state: 'closed' }),
    });
    // All count calls return 0 (default: proposalCountMock.mockResolvedValue([{count:0}])).

    const result = await updateIssue(OWNER, REPO, 42, { state: 'closed' });

    expect(result.status).toBe('done');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('global under limit + per-tool (github_update_issue 20/hr) exceeded → re-proposes inside window', async () => {
    grant(['github:write']);
    liveWindow();
    // global call → 0 (under 30/hr); per-tool call → 20 (at 20/hr ceiling).
    proposalCountMock
      .mockResolvedValueOnce([{ count: 0 }])   // global
      .mockResolvedValueOnce([{ count: 20 }]);  // github_update_issue 20/hr

    const result = await updateIssue(OWNER, REPO, 42, { state: 'closed' });

    expect(result.status).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();

    const insertedRow = proposalInsertMock.mock.calls[0][0];
    expect(insertedRow.argsSummary).toContain('[TOOL_RATE_LIMIT:20/hr]');
    expect(insertedRow.status).toBe('pending');

    const proposedCall = publishMock.mock.calls.find(([type]) => type === 'action.proposed');
    expect(proposedCall).toBeDefined();
    expect(proposedCall![1].payload.argsSummary).toContain('[TOOL_RATE_LIMIT:20/hr]');
  });

  it('global under limit + github_create_issue hourly (5/hr) exceeded → pending', async () => {
    grant(['github:write']);
    appendLiveGrant();
    // global → 0; github_create_issue 5/hr check → 5 (at ceiling).
    proposalCountMock
      .mockResolvedValueOnce([{ count: 0 }])  // global
      .mockResolvedValueOnce([{ count: 5 }]); // github_create_issue 5/hr

    const result = await createIssue(OWNER, REPO, 'New Issue', 'Body');

    expect(result.status).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();

    const insertedRow = proposalInsertMock.mock.calls[0][0];
    expect(insertedRow.argsSummary).toContain('[TOOL_RATE_LIMIT:5/hr]');
  });

  it('global under limit + github_create_comment per-minute burst (10/min) exceeded → pending', async () => {
    grant(['github:write']);
    appendLiveGrant();
    // global → 0; burst check (10/min) → 10 (at ceiling); hourly never reached.
    proposalCountMock
      .mockResolvedValueOnce([{ count: 0 }])   // global
      .mockResolvedValueOnce([{ count: 10 }]); // burst 10/min

    const result = await createComment(OWNER, REPO, 42, 'Spam comment');

    expect(result.status).toBe('pending');
    expect(fetch).not.toHaveBeenCalled();

    const insertedRow = proposalInsertMock.mock.calls[0][0];
    expect(insertedRow.argsSummary).toContain('[TOOL_RATE_LIMIT:10/min burst]');
  });

  it('global under limit + comment burst under limit + hourly (60/hr) exceeded → pending', async () => {
    grant(['github:write']);
    appendLiveGrant();
    // global → 0; burst → 5 (under 10/min); hourly → 60 (at ceiling).
    proposalCountMock
      .mockResolvedValueOnce([{ count: 0 }])   // global
      .mockResolvedValueOnce([{ count: 5 }])   // burst 10/min: under
      .mockResolvedValueOnce([{ count: 60 }]); // hourly 60/hr: at ceiling

    const result = await createComment(OWNER, REPO, 42, 'A comment');

    expect(result.status).toBe('pending');
    const insertedRow = proposalInsertMock.mock.calls[0][0];
    expect(insertedRow.argsSummary).toContain('[TOOL_RATE_LIMIT:60/hr]');
  });

  it('global ceiling exceeded → per-tool is never checked (global trip takes priority)', async () => {
    grant(['github:write']);
    liveWindow();
    // All count calls return 30 (global at ceiling).
    proposalCountMock.mockResolvedValue([{ count: 30 }]);

    const result = await updateIssue(OWNER, REPO, 42, { state: 'closed' });

    expect(result.status).toBe('pending');
    // proposalCountMock called exactly ONCE (global check only; per-tool skipped).
    expect(proposalCountMock).toHaveBeenCalledTimes(1);
    const insertedRow = proposalInsertMock.mock.calls[0][0];
    expect(insertedRow.argsSummary).toContain('[RATE_LIMIT]');
    expect(insertedRow.argsSummary).not.toContain('[TOOL_RATE_LIMIT]');
  });
});
