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
 * All write tools gate on `github:write`; read tools gate on `github:read`.
 * The per-tool `requiredScope` check in `handleMcpRpc` runs BEFORE the
 * handler — the connector lib's `requireGrantAndPat` is an additional
 * fail-closed check at the data layer (channel_links + vault).
 *
 * Template: modelled verbatim on media-write.ts (per #1228 spec).
 * RFC-32 federated-growth contract: only this file + tools/index.ts change
 * when adding or removing a GitHub tool.
 */
import type { McpTool, McpContent } from '../types';
import {
  sealPat,
  createIssue,
  createComment,
  listIssues,
  getIssue,
} from '@/src/lib/github/connector';

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === 'number' ? v : undefined;
}

function json(value: unknown): McpContent[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
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
    'Create a GitHub issue on your behalf using your sealed PAT. ' +
    'The issue is authored as you (your GitHub account owns the PAT). ' +
    'Requires an active github:write grant in your scope-manifest and a ' +
    'stored PAT from github_connect. ' +
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

    const issue = await createIssue(ctx.did, repo, title, body);

    return json({
      number: issue.number,
      url: issue.html_url,
      title: issue.title,
      state: issue.state,
      created_at: issue.created_at,
    });
  },
};

const createCommentTool: McpTool = {
  name: 'github_create_comment',
  requiredScope: 'github:write',
  description:
    'Add a comment to an existing GitHub issue on your behalf using your sealed PAT. ' +
    'Requires an active github:write grant in your scope-manifest and a stored PAT from github_connect. ' +
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

    const comment = await createComment(ctx.did, repo, issueNumber, body);

    return json({
      id: comment.id,
      url: comment.html_url,
      created_at: comment.created_at,
    });
  },
};

// ── B3 — Read tools ───────────────────────────────────────────────────────────

const listIssuesTool: McpTool = {
  name: 'github_list_issues',
  requiredScope: 'github:read',
  description:
    'List issues in a GitHub repository on your behalf using your sealed PAT. ' +
    'Returns up to 50 issues. ' +
    'Requires an active github:read grant in your scope-manifest and a stored PAT from github_connect. ' +
    'repo format: "owner/repo".',
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
    },
    required: ['repo'],
    additionalProperties: false,
  },
  async handler(args, ctx) {
    const repo = str(args, 'repo');
    if (repo === undefined) throw new Error('repo is required');

    const rawState = str(args, 'state');
    const state = rawState === 'closed' || rawState === 'all' ? rawState : 'open';

    const issues = await listIssues(ctx.did, repo, state);

    return json(
      issues.map((i) => ({
        number: i.number,
        url: i.html_url,
        title: i.title,
        state: i.state,
        created_at: i.created_at,
      })),
    );
  },
};

const getIssueTool: McpTool = {
  name: 'github_get_issue',
  requiredScope: 'github:read',
  description:
    'Get a single GitHub issue by number on your behalf using your sealed PAT. ' +
    'Requires an active github:read grant in your scope-manifest and a stored PAT from github_connect. ' +
    'repo format: "owner/repo".',
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

    return json({
      number: issue.number,
      url: issue.html_url,
      title: issue.title,
      state: issue.state,
      body: issue.body,
      user: issue.user?.login ?? null,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
    });
  },
};

export const githubTools: McpTool[] = [
  connectTool,
  createIssueTool,
  createCommentTool,
  listIssuesTool,
  getIssueTool,
];
