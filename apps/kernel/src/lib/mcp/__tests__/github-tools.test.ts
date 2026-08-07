/**
 * Tests for the GitHub MCP tool surface (#1528).
 *
 * The connector is mocked — its gating, pagination, and disclosure filtering are
 * covered by `lib/github/__tests__/connector.test.ts`. What matters here is the
 * tool layer's own contract:
 *   - every read verb stays on `github:read` and every write verb on
 *     `github:write` (no scope drift as the surface grows),
 *   - arguments reach the connector as typed options rather than raw strings,
 *   - responses carry the completeness signal (`has_more` / `incomplete`) so a
 *     truncated listing can never read as a complete one,
 *   - the fields #1528 called out as discarded (labels, assignees, milestone,
 *     comment count, updated_at) actually reach the caller.
 *
 * `lib/github/entities` is deliberately left REAL: it is I/O-free, and mocking
 * `labelNames` / `isPullRequest` would turn assertions about the projection into
 * assertions about the mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpContent, McpToolContext } from '../types';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@/src/lib/github/connector', () => ({
  sealPat: vi.fn(),
  createIssue: vi.fn(),
  createComment: vi.fn(),
  updateIssue: vi.fn(),
  listIssues: vi.fn(),
  getIssue: vi.fn(),
  listOrgs: vi.fn(),
  listRepos: vi.fn(),
  getRepo: vi.fn(),
  listPullRequests: vi.fn(),
  getPullRequest: vi.fn(),
  listComments: vi.fn(),
  searchIssues: vi.fn(),
}));

import { githubTools } from '../tools/github';
import {
  listIssues,
  getIssue,
  listPullRequests,
  getPullRequest,
  listComments,
  searchIssues,
} from '@/src/lib/github/connector';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from '@/src/lib/github/entities';

// ─── Helpers ────────────────────────────────────────────────────────────────

const REPO = 'ima-jin/imajin-ai';

const ctx: McpToolContext = {
  did: 'did:imajin:veteze',
  appDid: 'did:imajin:mcp-connector',
  scopes: new Set(['github:read', 'github:write']),
};

function tool(name: string) {
  const t = githubTools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

async function call(name: string, args: Record<string, unknown> = {}) {
  return (await tool(name).handler(args, ctx)) as McpContent[];
}

function parseResult(content: McpContent[]): Record<string, unknown> {
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

const ISSUE = {
  number: 42,
  html_url: `https://github.com/${REPO}/issues/42`,
  title: 'Test Issue',
  state: 'open',
  body: 'Issue body',
  user: { login: 'eric' },
  created_at: '2026-07-13T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
  labels: [{ name: 'bug' }, 'p1'],
  assignees: [{ login: 'eric' }, { login: 'ryan' }],
  milestone: { number: 3, title: 'M3', state: 'open', due_on: null },
  comments: 12,
  state_reason: null,
  locked: false,
  author_association: 'OWNER',
};

const PR = {
  number: 5,
  html_url: `https://github.com/${REPO}/pull/5`,
  title: 'Test PR',
  state: 'open',
  body: 'PR body',
  user: { login: 'eric' },
  created_at: '2026-07-13T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
  draft: true,
  head: { ref: 'feat/x', sha: 'abc', repo: { full_name: REPO } },
  base: { ref: 'main', sha: 'def', repo: { full_name: REPO } },
  requested_reviewers: [{ login: 'reviewer' }],
  labels: [{ name: 'enhancement' }],
};

const COMMENT = {
  id: 999,
  html_url: `https://github.com/${REPO}/issues/42#issuecomment-999`,
  body: 'A comment',
  user: { login: 'ryan' },
  created_at: '2026-07-13T00:00:00.000Z',
  updated_at: '2026-07-13T01:00:00.000Z',
  author_association: 'MEMBER',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listIssues).mockResolvedValue({ items: [ISSUE], hasMore: false, limit: DEFAULT_LIST_LIMIT });
  vi.mocked(getIssue).mockResolvedValue(ISSUE);
  vi.mocked(listPullRequests).mockResolvedValue({ items: [PR], hasMore: false, limit: DEFAULT_LIST_LIMIT });
  vi.mocked(getPullRequest).mockResolvedValue(PR);
  vi.mocked(listComments).mockResolvedValue({ items: [COMMENT], hasMore: false, limit: DEFAULT_LIST_LIMIT });
  vi.mocked(searchIssues).mockResolvedValue({
    items: [ISSUE], hasMore: false, limit: DEFAULT_LIST_LIMIT, totalCount: 1, incompleteResults: false,
  });
});

// ─── Registration + scope gating ────────────────────────────────────────────

const READ_TOOLS = [
  'github_list_issues',
  'github_get_issue',
  'github_list_orgs',
  'github_list_repos',
  'github_get_repo',
  'github_list_pull_requests',
  'github_get_pull_request',
  'github_list_comments',
  'github_search_issues',
];

const WRITE_TOOLS = [
  'github_connect',
  'github_create_issue',
  'github_create_comment',
  'github_update_issue',
];

/** Every tool that walks the GitHub Link header and can therefore truncate. */
const PAGINATED_TOOLS = [
  'github_list_issues',
  'github_list_pull_requests',
  'github_list_comments',
  'github_search_issues',
];

describe('registration (#1528)', () => {
  it('registers the new read verbs alongside the existing surface', () => {
    const names = githubTools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...READ_TOOLS, ...WRITE_TOOLS]));
    expect(names).toHaveLength(READ_TOOLS.length + WRITE_TOOLS.length);
  });

  it('exposes no duplicate tool names', () => {
    const names = githubTools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  /**
   * The whole point of #1528 is more reach on the SAME grant. If a read verb
   * ever landed on `github:write`, reading a repo would start requiring the
   * ability to change it.
   */
  it.each(READ_TOOLS)('gates %s on github:read', (name) => {
    expect(tool(name).requiredScope).toBe('github:read');
  });

  it.each(WRITE_TOOLS)('gates %s on github:write', (name) => {
    expect(tool(name).requiredScope).toBe('github:write');
  });

  it('introduces no scope outside the existing github:read/github:write pair', () => {
    const scopes = new Set(githubTools.map((t) => t.requiredScope));
    expect([...scopes].sort()).toEqual(['github:read', 'github:write']);
  });

  it('rejects unknown arguments on every tool schema (fail-closed)', () => {
    for (const t of githubTools) {
      expect(t.inputSchema.additionalProperties, t.name).toBe(false);
    }
  });

  it('documents every advertised argument so a caller need not guess', () => {
    for (const t of githubTools) {
      const properties = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [name, schema] of Object.entries(properties)) {
        expect(schema.description, `${t.name}.${name}`).toBeTruthy();
      }
    }
  });

  /**
   * A caller that cannot see the ceiling will pass a limit that gets silently
   * clamped and then trust the short result, so every paginated tool has to
   * advertise both the default and the ceiling on its `limit` argument.
   */
  it.each(PAGINATED_TOOLS)('advertises the limit default and ceiling on %s', (name) => {
    const properties = tool(name).inputSchema.properties as Record<string, { description?: string }>;
    expect(properties.limit?.description).toContain(String(DEFAULT_LIST_LIMIT));
    expect(properties.limit?.description).toContain(String(MAX_LIST_LIMIT));
  });
});

// ─── Pending-approval guidance (#1582) ──────────────────────────────────────

/**
 * These descriptions are what the model reads before it explains the pending
 * state to a human. When they said "After approving at
 * /github/api/confirm/{proposalId}", the model dutifully sent the first
 * external user to a POST-only endpoint and he hit a 405. The approval surface
 * a human can actually use is the /jin dashboard.
 */
const GATED_WRITE_TOOLS = ['github_create_issue', 'github_create_comment', 'github_update_issue'];

describe('pending-approval guidance (#1582)', () => {
  it.each(GATED_WRITE_TOOLS)('%s points at the /jin dashboard', (name) => {
    expect(tool(name).description).toContain('/jin dashboard');
  });

  it.each(GATED_WRITE_TOOLS)('%s does not frame the confirm path as somewhere to approve', (name) => {
    expect(tool(name).description).not.toMatch(/approv\w*\s+at\s+\S*\/github\/api\/confirm/i);
  });

  it.each(GATED_WRITE_TOOLS)('%s keeps the confirm path, labelled as the programmatic route', (name) => {
    const description = tool(name).description;
    expect(description).toContain('/github/api/confirm/{proposalId}');
    expect(description).toMatch(/programmatic/i);
  });

  /** Eleven queued writes should cost one approval, not eleven. */
  it.each(GATED_WRITE_TOOLS)('%s mentions the batching windows', (name) => {
    const description = tool(name).description;
    expect(description).toContain('5m');
    expect(description).toContain('24h');
  });

  /**
   * Only the connector knows the node's origin, so the description must send
   * the model to the pending response for the URL instead of inviting it to
   * invent a host (which is how the first-user report started).
   */
  it.each(GATED_WRITE_TOOLS)('%s defers to the pending response for the host', (name) => {
    expect(tool(name).description).toMatch(/fully-qualified URL/i);
  });
});

// ─── github_list_issues ─────────────────────────────────────────────────────

describe('github_list_issues (#1528)', () => {
  it('requires repo', async () => {
    await expect(tool('github_list_issues').handler({}, ctx)).rejects.toThrow(/repo is required/);
  });

  it('pins the read to ctx.did and defaults state/type', async () => {
    await call('github_list_issues', { repo: REPO });

    expect(listIssues).toHaveBeenCalledWith(ctx.did, REPO, expect.objectContaining({
      state: undefined,
      type: undefined,
    }));
  });

  it('forwards state, type, limit, labels, since, sort, and direction', async () => {
    await call('github_list_issues', {
      repo: REPO,
      state: 'all',
      type: 'pr',
      limit: 250,
      labels: 'bug,p1',
      since: '2026-01-01T00:00:00Z',
      sort: 'updated',
      direction: 'asc',
    });

    expect(listIssues).toHaveBeenCalledWith(ctx.did, REPO, {
      state: 'all',
      type: 'pr',
      limit: 250,
      labels: 'bug,p1',
      since: '2026-01-01T00:00:00Z',
      sort: 'updated',
      direction: 'asc',
    });
  });

  it('drops out-of-enum values rather than passing them to GitHub', async () => {
    await call('github_list_issues', { repo: REPO, state: 'banana', type: 'nope', sort: 'wat' });

    expect(listIssues).toHaveBeenCalledWith(ctx.did, REPO, expect.objectContaining({
      state: undefined, type: undefined, sort: undefined,
    }));
  });

  it('returns an envelope with count/limit/has_more, not a bare array', async () => {
    const out = parseResult(await call('github_list_issues', { repo: REPO }));

    expect(out).toMatchObject({ repo: REPO, count: 1, limit: DEFAULT_LIST_LIMIT, has_more: false });
    expect(Array.isArray(out.issues)).toBe(true);
  });

  /**
   * The regression #1528 exists to prevent: a truncated listing that reads as a
   * complete one. `has_more` must be true AND the payload must say what to do.
   */
  it('announces incompleteness when results were left behind', async () => {
    vi.mocked(listIssues).mockResolvedValue({ items: [ISSUE], hasMore: true, limit: 1 });

    const out = parseResult(await call('github_list_issues', { repo: REPO, limit: 1 }));

    expect(out.has_more).toBe(true);
    expect(out.incomplete).toContain('More results exist beyond limit=1');
    expect(out.incomplete).toContain('github_search_issues');
  });

  it('omits the incomplete notice when the listing is complete', async () => {
    const out = parseResult(await call('github_list_issues', { repo: REPO }));
    expect(out.incomplete).toBeUndefined();
  });

  it('projects labels, assignees, milestone, comment count, and updated_at', async () => {
    const out = parseResult(await call('github_list_issues', { repo: REPO }));
    const [issue] = out.issues as Record<string, unknown>[];

    expect(issue).toMatchObject({
      number: 42,
      url: ISSUE.html_url,
      labels: ['bug', 'p1'],
      assignees: ['eric', 'ryan'],
      comments: 12,
      updated_at: '2026-07-14T00:00:00.000Z',
      author_association: 'OWNER',
      is_pull_request: false,
    });
    expect(issue.milestone).toMatchObject({ number: 3, title: 'M3' });
  });

  it('flags rows that are really pull requests', async () => {
    vi.mocked(listIssues).mockResolvedValue({
      items: [{ ...ISSUE, pull_request: { html_url: 'https://x/pull/42' } }],
      hasMore: false,
      limit: DEFAULT_LIST_LIMIT,
    });

    const out = parseResult(await call('github_list_issues', { repo: REPO, type: 'all' }));
    expect((out.issues as Record<string, unknown>[])[0].is_pull_request).toBe(true);
  });

  it('tolerates an issue with none of the optional fields', async () => {
    vi.mocked(listIssues).mockResolvedValue({
      items: [{
        number: 1, html_url: 'u', title: 't', state: 'open', body: null, user: null,
        created_at: 'c', updated_at: 'u',
      }],
      hasMore: false,
      limit: DEFAULT_LIST_LIMIT,
    });

    const [issue] = parseResult(await call('github_list_issues', { repo: REPO })).issues as Record<string, unknown>[];
    expect(issue).toMatchObject({ labels: [], assignees: [], milestone: null, comments: 0, user: null });
  });
});

// ─── github_get_issue ───────────────────────────────────────────────────────

describe('github_get_issue (#1528)', () => {
  it('returns the body plus the expanded fields', async () => {
    const out = parseResult(await call('github_get_issue', { repo: REPO, issue_number: 42 }));

    expect(getIssue).toHaveBeenCalledWith(ctx.did, REPO, 42);
    expect(out).toMatchObject({ number: 42, body: 'Issue body', labels: ['bug', 'p1'], comments: 12 });
  });

  it('requires issue_number', async () => {
    await expect(tool('github_get_issue').handler({ repo: REPO }, ctx)).rejects.toThrow(/issue_number is required/);
  });
});

// ─── github_list_pull_requests ──────────────────────────────────────────────

describe('github_list_pull_requests (#1528)', () => {
  it('requires repo', async () => {
    await expect(tool('github_list_pull_requests').handler({}, ctx)).rejects.toThrow(/repo is required/);
  });

  it('forwards state/base/head/limit/sort/direction', async () => {
    await call('github_list_pull_requests', {
      repo: REPO, state: 'closed', base: 'main', head: 'eric:feat', limit: 10, sort: 'updated', direction: 'desc',
    });

    expect(listPullRequests).toHaveBeenCalledWith(ctx.did, REPO, {
      state: 'closed', base: 'main', head: 'eric:feat', limit: 10, sort: 'updated', direction: 'desc',
    });
  });

  it('returns head/base/draft/reviewers \u2014 the fields list_issues cannot give', async () => {
    const out = parseResult(await call('github_list_pull_requests', { repo: REPO }));
    const [pr] = out.pull_requests as Record<string, unknown>[];

    expect(out).toMatchObject({ repo: REPO, count: 1, has_more: false });
    expect(pr).toMatchObject({
      number: 5,
      draft: true,
      requested_reviewers: ['reviewer'],
      labels: ['enhancement'],
    });
    expect(pr.head).toMatchObject({ ref: 'feat/x', repo: REPO });
    expect(pr.base).toMatchObject({ ref: 'main', repo: REPO });
  });

  /**
   * GitHub omits mergeability from list responses. Reporting null (rather than
   * false) keeps "not computed" from reading as "cannot merge".
   */
  it('reports unreported mergeability as null on list rows', async () => {
    const [pr] = parseResult(await call('github_list_pull_requests', { repo: REPO })).pull_requests as Record<string, unknown>[];
    expect(pr.mergeable).toBeNull();
    expect(pr.mergeable_state).toBeNull();
  });

  it('announces incompleteness when results were left behind', async () => {
    vi.mocked(listPullRequests).mockResolvedValue({ items: [PR], hasMore: true, limit: 1 });

    const out = parseResult(await call('github_list_pull_requests', { repo: REPO, limit: 1 }));

    expect(out.has_more).toBe(true);
    expect(out.incomplete).toContain('More results exist beyond limit=1');
  });
});

// ─── github_get_pull_request ────────────────────────────────────────────────

describe('github_get_pull_request (#1528)', () => {
  it('requires pull_number', async () => {
    await expect(tool('github_get_pull_request').handler({ repo: REPO }, ctx)).rejects.toThrow(/pull_number is required/);
  });

  it('returns body plus the detail-only merge and diff fields', async () => {
    vi.mocked(getPullRequest).mockResolvedValue({
      ...PR, mergeable: true, mergeable_state: 'clean', commits: 4, additions: 100, deletions: 20, changed_files: 3,
    });

    const out = parseResult(await call('github_get_pull_request', { repo: REPO, pull_number: 5 }));

    expect(getPullRequest).toHaveBeenCalledWith(ctx.did, REPO, 5);
    expect(out).toMatchObject({
      number: 5, body: 'PR body', mergeable: true, mergeable_state: 'clean',
      commits: 4, additions: 100, deletions: 20, changed_files: 3,
    });
  });
});

// ─── github_list_comments ───────────────────────────────────────────────────

describe('github_list_comments (#1528)', () => {
  it('requires repo and issue_number', async () => {
    await expect(tool('github_list_comments').handler({}, ctx)).rejects.toThrow(/repo is required/);
    await expect(tool('github_list_comments').handler({ repo: REPO }, ctx)).rejects.toThrow(/issue_number is required/);
  });

  it('forwards limit/since/direction and echoes the target', async () => {
    await call('github_list_comments', {
      repo: REPO, issue_number: 42, limit: 25, since: '2026-01-01T00:00:00Z', direction: 'asc',
    });

    expect(listComments).toHaveBeenCalledWith(ctx.did, REPO, 42, {
      limit: 25, since: '2026-01-01T00:00:00Z', direction: 'asc',
    });
  });

  it('returns author, body, and timestamps per comment', async () => {
    const out = parseResult(await call('github_list_comments', { repo: REPO, issue_number: 42 }));
    const [comment] = out.comments as Record<string, unknown>[];

    expect(out).toMatchObject({ repo: REPO, issue_number: 42, count: 1, has_more: false });
    expect(comment).toMatchObject({
      id: 999, user: 'ryan', body: 'A comment', author_association: 'MEMBER',
      updated_at: '2026-07-13T01:00:00.000Z',
    });
  });

  it('announces incompleteness when results were left behind', async () => {
    vi.mocked(listComments).mockResolvedValue({ items: [COMMENT], hasMore: true, limit: 1 });

    const out = parseResult(await call('github_list_comments', { repo: REPO, issue_number: 42, limit: 1 }));
    expect(out.incomplete).toContain('More results exist beyond limit=1');
  });
});

// ─── github_search_issues ───────────────────────────────────────────────────

describe('github_search_issues (#1528)', () => {
  it('requires query', async () => {
    await expect(tool('github_search_issues').handler({}, ctx)).rejects.toThrow(/query is required/);
  });

  it('forwards the query verbatim with limit/sort/order', async () => {
    await call('github_search_issues', {
      query: 'repo:ima-jin/imajin-ai is:open label:bug', limit: 30, sort: 'updated', order: 'desc',
    });

    expect(searchIssues).toHaveBeenCalledWith(
      ctx.did,
      'repo:ima-jin/imajin-ai is:open label:bug',
      { limit: 30, sort: 'updated', order: 'desc' },
    );
  });

  /**
   * total_count (all matches) and has_more (our own limit) and
   * incomplete_results (GitHub's search timed out) are three different facts;
   * collapsing any of them would misreport the size of the result set.
   */
  it('reports total_count, has_more, and incomplete_results independently', async () => {
    vi.mocked(searchIssues).mockResolvedValue({
      items: [ISSUE], hasMore: true, limit: 1, totalCount: 137, incompleteResults: true,
    });

    const out = parseResult(await call('github_search_issues', { query: 'is:open', limit: 1 }));

    expect(out).toMatchObject({
      query: 'is:open',
      total_count: 137,
      count: 1,
      limit: 1,
      has_more: true,
      incomplete_results: true,
    });
    expect(out.incomplete).toContain('More results exist beyond limit=1');
  });

  it('projects search hits through the same issue shape', async () => {
    const [item] = parseResult(await call('github_search_issues', { query: 'is:open' })).items as Record<string, unknown>[];
    expect(item).toMatchObject({ number: 42, labels: ['bug', 'p1'], is_pull_request: false });
  });
});
