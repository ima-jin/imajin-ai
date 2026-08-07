/**
 * MCP GitHub connector tools (#1228, Stage B3 + B4).
 *
 * Adds `github_*` tools to the MCP registry. All tools act on behalf of
 * `ctx.did` (the resource-owner DID from the OAuth access token); no tool
 * ever accesses a different DID's vault or grant.
 *
 * ── B4 — PAT ingestion ────────────────────────────────────────────────────────
 * `github_connect`: takes the PAT and seals it immediately via the vault.
 * The PAT is NEVER logged, NEVER echoed back, NEVER exposed beyond the
 * scope of the `sealPat` call.
 *
 * ── B3 — GitHub actions ───────────────────────────────────────────────────────
 * `github_create_issue`  — requiredScope: 'github:write'
 * `github_create_comment`— requiredScope: 'github:write'
 * `github_list_issues`   — requiredScope: 'github:read'
 * `github_get_issue`     — requiredScope: 'github:read'
 *
 * ── #1373 — org/repo discovery (read-tier, disclosure allowlist) ───────────────
 * `github_list_orgs`     — requiredScope: 'github:read'
 * `github_list_repos`    — requiredScope: 'github:read'
 * `github_get_repo`      — requiredScope: 'github:read'
 * These answer "what orgs/repos can this connection see?" so a write can be
 * targeted. Results are filtered server-side against the `github:read` manifest
 * allowlist (a DISCLOSURE bound, not a capability bound — the OAuth `repo` scope
 * is the capability bound at GitHub).
 *
 * ── #1528 — read depth (all read-tier, no new scopes) ─────────────────────────
 * `github_list_pull_requests` / `github_get_pull_request` — PRs as PRs, with
 *   head/base/draft/merge state, instead of unlabelled rows inside list_issues.
 * `github_list_comments`      — read the discussion on an issue or PR.
 * `github_search_issues`      — GitHub query syntax (`is:open label:bug`).
 *
 * Every list tool returns an OBJECT, not a bare array:
 *   { count, limit, has_more, incomplete?, <items> }
 * `has_more` is load-bearing. A bare array cannot distinguish "that is all of
 * them" from "that is the first N of an unknown number", and an agent that
 * cannot tell those apart will state the wrong total with full confidence. When
 * `has_more` is true an `incomplete` string spells out how to get the rest.
 *
 * All write tools gate on `github:write`; read tools gate on `github:read`.
 * The per-tool `requiredScope` check in `handleMcpRpc` runs BEFORE the
 * handler — the connector lib's `requireGrantAndPat` is an additional
 * fail-closed check at the data layer (channel_links + vault).
 *
 * Template: modelled verbatim on media-write.ts (per #1228 spec).
 * RFC-32 federated-growth contract: only this file + tools/index.ts change
 * when adding or removing a GitHub tool.
 */
import type { McpTool } from '../types';
import { str, num, json } from './utils';
import {
  sealPat,
  createIssue,
  createComment,
  listIssues,
  getIssue,
  updateIssue,
  listOrgs,
  listRepos,
  getRepo,
  listPullRequests,
  getPullRequest,
  listComments,
  searchIssues,
} from '@/src/lib/github/connector';
// Pure shapes/limits come from the I/O-free leaf rather than `./connector`, so
// this module's projections stay unit-testable with the connector mocked out.
import {
  isPullRequest,
  labelNames,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  type GitHubIssue,
  type GitHubComment,
  type GitHubIssueType,
  type GitHubListResult,
  type GitHubMilestone,
  type GitHubPullRef,
  type GitHubPullRequest,
  type GitHubUserRef,
} from '@/src/lib/github/entities';

// ── #1528 shared shaping helpers ──────────────────────────────────────────────

/** Pick `value` when it is one of `allowed`, else undefined (leave the default). */
function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

/** Shared `limit` JSON-Schema property so every list tool advertises one rule. */
const limitProperty = {
  type: 'number',
  description:
    `Max items to return (default ${DEFAULT_LIST_LIMIT}, ceiling ${MAX_LIST_LIMIT}). ` +
    'Results are paginated server-side via the GitHub Link header; if more exist ' +
    'than the limit allows, has_more is true and nothing is silently dropped.',
} as const;

/**
 * Wrap a page of results with its completeness signal.
 *
 * `incomplete` is prose rather than a flag because the consumer is a model: it
 * needs to be told what to do next, not just that something is missing.
 */
function listEnvelope<T>(
  result: Readonly<GitHubListResult<T>>,
  itemCount: number,
  nextStep: string,
): Record<string, unknown> {
  return {
    count: itemCount,
    limit: result.limit,
    has_more: result.hasMore,
    ...(result.hasMore
      ? { incomplete: `More results exist beyond limit=${result.limit}. ${nextStep}` }
      : {}),
  };
}

function logins(users: readonly GitHubUserRef[] | null | undefined): string[] {
  return (users ?? []).map((u) => u.login);
}

function milestoneOf(milestone: GitHubMilestone | null | undefined): Record<string, unknown> | null {
  if (milestone === null || milestone === undefined) return null;
  return {
    number: milestone.number,
    title: milestone.title,
    state: milestone.state,
    due_on: milestone.due_on ?? null,
  };
}

function refOf(ref: GitHubPullRef | undefined): Record<string, unknown> | null {
  if (ref === undefined) return null;
  return { ref: ref.ref, sha: ref.sha ?? null, repo: ref.repo?.full_name ?? null };
}

/**
 * The issue projection returned by list/search. Carries the fields #1528 called
 * out as discarded — labels, assignees, milestone, comment count, updated_at —
 * plus `is_pull_request`, so a caller reading a mixed listing never has to guess
 * which rows are PRs.
 */
function shapeIssue(issue: Readonly<GitHubIssue>): Record<string, unknown> {
  return {
    number: issue.number,
    url: issue.html_url,
    title: issue.title,
    state: issue.state,
    state_reason: issue.state_reason ?? null,
    is_pull_request: isPullRequest(issue),
    user: issue.user?.login ?? null,
    labels: labelNames(issue.labels),
    assignees: logins(issue.assignees),
    milestone: milestoneOf(issue.milestone),
    comments: issue.comments ?? 0,
    locked: issue.locked ?? false,
    author_association: issue.author_association ?? null,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at ?? null,
  };
}

function shapePullRequest(pr: Readonly<GitHubPullRequest>): Record<string, unknown> {
  return {
    number: pr.number,
    url: pr.html_url,
    title: pr.title,
    state: pr.state,
    draft: pr.draft ?? false,
    merged: pr.merged ?? null,
    // mergeable / mergeable_state are computed asynchronously by GitHub and are
    // only populated on the single-PR endpoint — null here means "not reported",
    // never "cannot merge".
    mergeable: pr.mergeable ?? null,
    mergeable_state: pr.mergeable_state ?? null,
    head: refOf(pr.head),
    base: refOf(pr.base),
    user: pr.user?.login ?? null,
    requested_reviewers: logins(pr.requested_reviewers),
    labels: labelNames(pr.labels),
    assignees: logins(pr.assignees),
    milestone: milestoneOf(pr.milestone),
    comments: pr.comments ?? null,
    review_comments: pr.review_comments ?? null,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at ?? null,
    merged_at: pr.merged_at ?? null,
  };
}

function shapeComment(comment: Readonly<GitHubComment>): Record<string, unknown> {
  return {
    id: comment.id,
    url: comment.html_url,
    user: comment.user?.login ?? null,
    body: comment.body,
    author_association: comment.author_association ?? null,
    created_at: comment.created_at,
    updated_at: comment.updated_at ?? null,
  };
}

// ── B4 — PAT ingestion ────────────────────────────────────────────────────────

const connectTool: McpTool = {
  name: 'github_connect',
  requiredScope: 'github:write',
  description:
    'Seal your GitHub Personal Access Token (PAT) in the Imajin vault so that ' +
    'github_create_issue and github_create_comment can act on your behalf. ' +
    'The PAT is encrypted immediately on receipt and is never logged, echoed, ' +
    'or returned. Run this once; re-run to rotate the token. ' +
    'Requires an active github:write grant in your scope-manifest.',
  inputSchema: {
    type: 'object',
    properties: {
      pat: {
        type: 'string',
        description: 'Your GitHub fine-grained or classic PAT (ghp_... or github_pat_...)',
      },
    },
    required: ['pat'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const pat = str(args, 'pat');
    if (pat === undefined) throw new Error('pat is required');

    await sealPat(ctx.did, pat);

    // Do NOT echo the PAT or any derivative. Return only a safe confirmation.
    return json({ connected: true, did: ctx.did });
  },
};

// ── B3 — Write tools ──────────────────────────────────────────────────────────

const createIssueTool: McpTool = {
  name: 'github_create_issue',
  requiredScope: 'github:write',
  description:
    'Create a GitHub issue on your behalf using your sealed credential (append tier). ' +
    'The first call proposes the action and returns a pending response if no live append ' +
    'approval window exists. After approving at /github/api/confirm/{proposalId}, retry ' +
    'this call to execute. ' +
    'Requires an active github:write grant in your scope-manifest and a ' +
    'stored credential from github_connect. ' +
    'repo format: "owner/repo" (e.g. "a-r-t-i-f-a-c-t/artifactagent").',
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in "owner/repo" format',
      },
      title: {
        type: 'string',
        description: 'Issue title',
      },
      body: {
        type: 'string',
        description: 'Issue body (Markdown)',
      },
    },
    required: ['repo', 'title', 'body'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const repo = str(args, 'repo');
    if (repo === undefined) throw new Error('repo is required');
    const title = str(args, 'title');
    if (title === undefined) throw new Error('title is required');
    const body = typeof args.body === 'string' ? args.body : '';

    const result = await createIssue(ctx.did, repo, title, body);

    if (result.status === 'pending') {
      return json({ pending: true, proposalId: result.proposalId, message: result.message });
    }

    return json({
      number: result.data.number,
      url: result.data.html_url,
      title: result.data.title,
      state: result.data.state,
      created_at: result.data.created_at,
    });
  },
};

const createCommentTool: McpTool = {
  name: 'github_create_comment',
  requiredScope: 'github:write',
  description:
    'Add a comment to an existing GitHub issue on your behalf using your sealed credential (append tier). ' +
    'The first call proposes the action and returns a pending response if no live append ' +
    'approval window exists. After approving at /github/api/confirm/{proposalId}, retry this call. ' +
    'Requires an active github:write grant in your scope-manifest and a stored credential from github_connect. ' +
    'repo format: "owner/repo" (e.g. "a-r-t-i-f-a-c-t/artifactagent").',
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in "owner/repo" format',
      },
      issue_number: {
        type: 'number',
        description: 'Issue number to comment on',
      },
      body: {
        type: 'string',
        description: 'Comment body (Markdown)',
      },
    },
    required: ['repo', 'issue_number', 'body'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const repo = str(args, 'repo');
    if (repo === undefined) throw new Error('repo is required');
    const issueNumber = num(args, 'issue_number');
    if (issueNumber === undefined) throw new Error('issue_number is required');
    const body = typeof args.body === 'string' ? args.body : '';

    const result = await createComment(ctx.did, repo, issueNumber, body);

    if (result.status === 'pending') {
      return json({ pending: true, proposalId: result.proposalId, message: result.message });
    }

    return json({
      id: result.data.id,
      url: result.data.html_url,
      created_at: result.data.created_at,
    });
  },
};

// ── B3 — Read tools ───────────────────────────────────────────────────────────

const listIssuesTool: McpTool = {
  name: 'github_list_issues',
  requiredScope: 'github:read',
  description:
    'List issues in a GitHub repository on your behalf using your sealed credential. ' +
    'Paginates through the GitHub Link header up to `limit` ' +
    `(default ${DEFAULT_LIST_LIMIT}, ceiling ${MAX_LIST_LIMIT}) and returns ` +
    '{ count, limit, has_more, incomplete?, issues }. ALWAYS check has_more before ' +
    'stating a total — when it is true you are looking at a prefix, not the whole set. ' +
    'Pull requests are EXCLUDED by default (GitHub returns them from the issues ' +
    'endpoint); pass type="pr" or type="all" to include them, or use ' +
    'github_list_pull_requests for PR-specific fields. Each row includes labels, ' +
    'assignees, milestone, comment count, and updated_at. ' +
    'Requires an active github:read grant in your scope-manifest and a stored ' +
    'credential from github_connect. repo format: "owner/repo".',
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in "owner/repo" format',
      },
      state: {
        type: 'string',
        enum: ['open', 'closed', 'all'],
        description: 'Issue state filter (defaults to "open")',
      },
      type: {
        type: 'string',
        enum: ['issue', 'pr', 'all'],
        description:
          'Which rows to return: "issue" (default, excludes pull requests), ' +
          '"pr" (only pull requests), or "all"',
      },
      limit: limitProperty,
      labels: {
        type: 'string',
        description: 'Comma-separated label names to filter by (e.g. "bug,p1")',
      },
      since: {
        type: 'string',
        description: 'Only issues updated at or after this ISO-8601 timestamp',
      },
      sort: {
        type: 'string',
        enum: ['created', 'updated', 'comments'],
        description: 'Sort field (defaults to GitHub\u2019s "created")',
      },
      direction: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'Sort direction (defaults to GitHub\u2019s "desc")',
      },
    },
    required: ['repo'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const repo = str(args, 'repo');
    if (repo === undefined) throw new Error('repo is required');

    const result = await listIssues(ctx.did, repo, {
      state: oneOf(str(args, 'state'), ['open', 'closed', 'all'] as const),
      type: oneOf(str(args, 'type'), ['issue', 'pr', 'all'] as const satisfies readonly GitHubIssueType[]),
      limit: num(args, 'limit'),
      labels: str(args, 'labels'),
      since: str(args, 'since'),
      sort: oneOf(str(args, 'sort'), ['created', 'updated', 'comments'] as const),
      direction: oneOf(str(args, 'direction'), ['asc', 'desc'] as const),
    });

    return json({
      repo,
      ...listEnvelope(
        result,
        result.items.length,
        `Raise limit (max ${MAX_LIST_LIMIT}), narrow with state/labels/since, ` +
        'or use github_search_issues for a targeted query.',
      ),
      issues: result.items.map(shapeIssue),
    });
  },
};

const getIssueTool: McpTool = {
  name: 'github_get_issue',
  requiredScope: 'github:read',
  description:
    'Get a single GitHub issue by number on your behalf using your sealed credential, ' +
    'including body, labels, assignees, milestone, and comment count. ' +
    'is_pull_request tells you whether this number is actually a PR — if so, ' +
    'github_get_pull_request returns the branch and merge detail this tool cannot. ' +
    'Requires an active github:read grant in your scope-manifest and a stored ' +
    'credential from github_connect. repo format: "owner/repo".',
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in "owner/repo" format',
      },
      issue_number: {
        type: 'number',
        description: 'Issue number to retrieve',
      },
    },
    required: ['repo', 'issue_number'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const repo = str(args, 'repo');
    if (repo === undefined) throw new Error('repo is required');
    const issueNumber = num(args, 'issue_number');
    if (issueNumber === undefined) throw new Error('issue_number is required');

    const issue = await getIssue(ctx.did, repo, issueNumber);

    return json({ ...shapeIssue(issue), body: issue.body });
  },
};

// ── #1528 — Pull request reads ─────────────────────────────────────────────

const listPullRequestsTool: McpTool = {
  name: 'github_list_pull_requests',
  requiredScope: 'github:read',
  description:
    'List pull requests in a GitHub repository on your behalf using your sealed ' +
    'credential. Unlike github_list_issues (which can only tell you a row IS a PR), ' +
    'this returns PR-specific fields: head/base branches, draft status, merge state, ' +
    'requested reviewers. Paginates via the Link header up to `limit` and returns ' +
    '{ count, limit, has_more, incomplete?, pull_requests }; check has_more before ' +
    'stating a total. Read-tier: no confirm step. ' +
    'Requires an active github:read grant in your scope-manifest and a stored ' +
    'credential from github_connect. repo format: "owner/repo".',
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in "owner/repo" format',
      },
      state: {
        type: 'string',
        enum: ['open', 'closed', 'all'],
        description: 'PR state filter (defaults to "open")',
      },
      base: {
        type: 'string',
        description: 'Filter by base branch name (e.g. "main")',
      },
      head: {
        type: 'string',
        description: 'Filter by head branch in "user:ref-name" form',
      },
      limit: limitProperty,
      sort: {
        type: 'string',
        enum: ['created', 'updated', 'popularity', 'long-running'],
        description: 'Sort field (defaults to GitHub\u2019s "created")',
      },
      direction: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'Sort direction',
      },
    },
    required: ['repo'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const repo = str(args, 'repo');
    if (repo === undefined) throw new Error('repo is required');

    const result = await listPullRequests(ctx.did, repo, {
      state: oneOf(str(args, 'state'), ['open', 'closed', 'all'] as const),
      base: str(args, 'base'),
      head: str(args, 'head'),
      limit: num(args, 'limit'),
      sort: oneOf(str(args, 'sort'), ['created', 'updated', 'popularity', 'long-running'] as const),
      direction: oneOf(str(args, 'direction'), ['asc', 'desc'] as const),
    });

    return json({
      repo,
      ...listEnvelope(
        result,
        result.items.length,
        `Raise limit (max ${MAX_LIST_LIMIT}), or narrow with state/base/head.`,
      ),
      pull_requests: result.items.map(shapePullRequest),
    });
  },
};

const getPullRequestTool: McpTool = {
  name: 'github_get_pull_request',
  requiredScope: 'github:read',
  description:
    'Get a single pull request by number on your behalf using your sealed credential. ' +
    'This is the only tool that returns mergeability and diff size (mergeable, ' +
    'mergeable_state, commits, additions, deletions, changed_files) — GitHub does not ' +
    'populate those on list responses. A null mergeable means GitHub has not computed ' +
    'it yet, not that the PR conflicts. Read-tier: no confirm step. ' +
    'Requires an active github:read grant in your scope-manifest and a stored ' +
    'credential from github_connect. repo format: "owner/repo".',
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in "owner/repo" format',
      },
      pull_number: {
        type: 'number',
        description: 'Pull request number to retrieve',
      },
    },
    required: ['repo', 'pull_number'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const repo = str(args, 'repo');
    if (repo === undefined) throw new Error('repo is required');
    const pullNumber = num(args, 'pull_number');
    if (pullNumber === undefined) throw new Error('pull_number is required');

    const pr = await getPullRequest(ctx.did, repo, pullNumber);

    return json({
      ...shapePullRequest(pr),
      body: pr.body,
      commits: pr.commits ?? null,
      additions: pr.additions ?? null,
      deletions: pr.deletions ?? null,
      changed_files: pr.changed_files ?? null,
    });
  },
};

// ── #1528 — Comment reads ──────────────────────────────────────────────────

const listCommentsTool: McpTool = {
  name: 'github_list_comments',
  requiredScope: 'github:read',
  description:
    'Read the discussion on a GitHub issue or pull request — the conversation that ' +
    'explains why the thing is in the state it is in. PR numbers work here too: ' +
    'GitHub treats PR conversation comments as issue comments. (Inline review ' +
    'comments on a diff are a separate surface and are not returned.) ' +
    'Paginates via the Link header up to `limit` and returns ' +
    '{ count, limit, has_more, incomplete?, comments }. Read-tier: no confirm step. ' +
    'Requires an active github:read grant in your scope-manifest and a stored ' +
    'credential from github_connect. repo format: "owner/repo".',
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in "owner/repo" format',
      },
      issue_number: {
        type: 'number',
        description: 'Issue or pull request number whose comments to read',
      },
      limit: limitProperty,
      since: {
        type: 'string',
        description: 'Only comments updated at or after this ISO-8601 timestamp',
      },
      direction: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'Sort direction by creation date',
      },
    },
    required: ['repo', 'issue_number'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const repo = str(args, 'repo');
    if (repo === undefined) throw new Error('repo is required');
    const issueNumber = num(args, 'issue_number');
    if (issueNumber === undefined) throw new Error('issue_number is required');

    const result = await listComments(ctx.did, repo, issueNumber, {
      limit: num(args, 'limit'),
      since: str(args, 'since'),
      direction: oneOf(str(args, 'direction'), ['asc', 'desc'] as const),
    });

    return json({
      repo,
      issue_number: issueNumber,
      ...listEnvelope(
        result,
        result.items.length,
        `Raise limit (max ${MAX_LIST_LIMIT}) or narrow with since.`,
      ),
      comments: result.items.map(shapeComment),
    });
  },
};

// ── #1528 — Search ───────────────────────────────────────────────────────

const searchIssuesTool: McpTool = {
  name: 'github_search_issues',
  requiredScope: 'github:read',
  description:
    'Search issues and pull requests with GitHub query syntax on your behalf using ' +
    'your sealed credential — e.g. "repo:ima-jin/imajin-ai is:issue is:open label:bug", ' +
    '"is:pr author:@me is:open", "assignee:@me updated:>2026-01-01". Use this for ' +
    'questions no combination of github_list_issues filters can express, and when a ' +
    'listing came back with has_more. Returns { query, total_count, count, limit, ' +
    'has_more, incomplete_results, items }; total_count is GitHub\u2019s count of ALL ' +
    'matches, which is usually larger than what is returned. Results are filtered by ' +
    'the disclosure allowlist on your github:read grant, so a repo you chose not to ' +
    'disclose will not appear here either. Read-tier: no confirm step. ' +
    'Requires an active github:read grant in your scope-manifest and a stored ' +
    'credential from github_connect.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'GitHub search query (the same syntax as the GitHub issue search box). ' +
          'Scope it with repo:owner/name or org:name to keep results relevant.',
      },
      limit: limitProperty,
      sort: {
        type: 'string',
        enum: ['comments', 'created', 'updated', 'reactions'],
        description: 'Sort field (defaults to best match)',
      },
      order: {
        type: 'string',
        enum: ['asc', 'desc'],
        description: 'Sort order',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const query = str(args, 'query');
    if (query === undefined) throw new Error('query is required');

    const result = await searchIssues(ctx.did, query, {
      limit: num(args, 'limit'),
      sort: oneOf(str(args, 'sort'), ['comments', 'created', 'updated', 'reactions'] as const),
      order: oneOf(str(args, 'order'), ['asc', 'desc'] as const),
    });

    return json({
      query,
      total_count: result.totalCount,
      // GitHub's own flag: the search timed out and the index was only partly
      // consulted. Distinct from has_more, which is about our own limit.
      incomplete_results: result.incompleteResults,
      ...listEnvelope(
        result,
        result.items.length,
        `Raise limit (max ${MAX_LIST_LIMIT}) or narrow the query.`,
      ),
      items: result.items.map(shapeIssue),
    });
  },
};

const updateIssueTool: McpTool = {
  name: 'github_update_issue',
  requiredScope: 'github:write',
  description:
    'Update an existing GitHub issue (title, body, and/or state) on your behalf using your sealed ' +
    'credential. This is a mutating write — the first call proposes the action and returns a pending ' +
    'response. After you approve at /github/api/confirm/{proposalId}, retry this call to execute. ' +
    'Requires an active github:write grant in your scope-manifest and a stored credential from ' +
    'github_connect. repo format: "owner/repo".',
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in "owner/repo" format',
      },
      issue_number: {
        type: 'number',
        description: 'Issue number to update',
      },
      title: {
        type: 'string',
        description: 'New issue title (optional)',
      },
      body: {
        type: 'string',
        description: 'New issue body in Markdown (optional)',
      },
      state: {
        type: 'string',
        enum: ['open', 'closed'],
        description: 'New issue state (optional)',
      },
    },
    required: ['repo', 'issue_number'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const repo = str(args, 'repo');
    if (repo === undefined) throw new Error('repo is required');
    const issueNumber = num(args, 'issue_number');
    if (issueNumber === undefined) throw new Error('issue_number is required');

    const updates: { title?: string; body?: string; state?: 'open' | 'closed' } = {};
    const title = str(args, 'title');
    if (title !== undefined) updates.title = title;
    const body = str(args, 'body');
    if (body !== undefined) updates.body = body;
    const rawState = str(args, 'state');
    if (rawState === 'open' || rawState === 'closed') updates.state = rawState;

    if (Object.keys(updates).length === 0) throw new Error('at least one of title, body, or state is required');

    const result = await updateIssue(ctx.did, repo, issueNumber, updates);

    if (result.status === 'pending') {
      return json({
        pending: true,
        proposalId: result.proposalId,
        message: result.message,
      });
    }

    return json({
      number: result.data.number,
      url: result.data.html_url,
      title: result.data.title,
      state: result.data.state,
      updated_at: result.data.updated_at,
    });
  },
};

// ── #1373 — Org / repo discovery tools (read-tier) ────────────────────────────

const listOrgsTool: McpTool = {
  name: 'github_list_orgs',
  requiredScope: 'github:read',
  description:
    'List the GitHub organizations this connection can see, so you can discover ' +
    'where you are able to act before targeting a write. Read-tier: no confirm ' +
    'step. Results are filtered by the disclosure allowlist on your github:read ' +
    'grant (empty/absent = all visible orgs). ' +
    'Requires an active github:read grant in your scope-manifest and a stored ' +
    'credential from github_connect.',
  inputSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  async handler(_args, ctx) {
    const orgs = await listOrgs(ctx.did);
    return json(orgs.map((o) => ({ login: o.login, id: o.id, description: o.description })));
  },
};

const listReposTool: McpTool = {
  name: 'github_list_repos',
  requiredScope: 'github:read',
  description:
    'List the GitHub repositories this connection can see (optionally scoped to a ' +
    'single org), returning the fields needed to target a write: full_name, ' +
    'private, permissions, default_branch. Read-tier: no confirm step. Results are ' +
    'filtered by the disclosure allowlist on your github:read grant ' +
    '(empty/absent = all visible repos). ' +
    'Requires an active github:read grant in your scope-manifest and a stored ' +
    'credential from github_connect.',
  inputSchema: {
    type: 'object',
    properties: {
      org: {
        type: 'string',
        description: 'Optional org login to scope the listing (e.g. "ima-jin")',
      },
    },
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const org = str(args, 'org');
    const repos = await listRepos(ctx.did, org);
    return json(
      repos.map((r) => ({
        full_name: r.full_name,
        private: r.private,
        permissions: r.permissions ?? null,
        default_branch: r.default_branch,
        html_url: r.html_url,
        description: r.description,
      })),
    );
  },
};

const getRepoTool: McpTool = {
  name: 'github_get_repo',
  requiredScope: 'github:read',
  description:
    'Get a single repository\u2019s detail (permissions, default branch, visibility) ' +
    'before acting on it. Read-tier: no confirm step. If the repo is outside the ' +
    'disclosure allowlist on your github:read grant, this returns a ' +
    'github_not_in_scope error and never fetches or reveals the repo. ' +
    'Requires an active github:read grant in your scope-manifest and a stored ' +
    'credential from github_connect. repo format: "owner/repo".',
  inputSchema: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'Repository in "owner/repo" format',
      },
    },
    required: ['repo'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const repo = str(args, 'repo');
    if (repo === undefined) throw new Error('repo is required');

    const data = await getRepo(ctx.did, repo);

    return json({
      full_name: data.full_name,
      private: data.private,
      permissions: data.permissions ?? null,
      default_branch: data.default_branch,
      html_url: data.html_url,
      description: data.description,
    });
  },
};

export const githubTools: McpTool[] = [
  connectTool,
  createIssueTool,
  createCommentTool,
  listIssuesTool,
  getIssueTool,
  updateIssueTool,
  listOrgsTool,
  listReposTool,
  getRepoTool,
  // #1528 — read depth. All read-tier ('github:read'); no scope change.
  listPullRequestsTool,
  getPullRequestTool,
  listCommentsTool,
  searchIssuesTool,
];
