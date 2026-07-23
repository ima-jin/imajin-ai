/**
 * GitHub connector backend library (#1228, Stage B2; OAuth2 #1333; confirm rail #1366, #1370).
 *
 * Connects a human DID's GitHub account (OAuth2 or PAT fallback) to the
 * GitHub REST API, gated by an active `auth.channel_links` row. The OAuth2
 * plumbing is provided by `createConnectorOAuth` (#1333); only GitHub-specific
 * details live here: the repo scope, body-param token auth, optional-expiry
 * token shape, PAT fallback, and issue/comment bus events.
 *
 * ── Confirm rail + append/mutate tiering (#1366, #1370) ────────────────────────
 * All writes go through `requireWriteGate()` (via tier-specific wrappers) AFTER
 * `requireGrantAndToken()`. The gate is parameterised by `risk`:
 *
 *   'append'  — additive / reversible (create_issue, create_comment).
 *              Proceed under a live append window; propose on no window.
 *   'mutate'  — alters existing state (update_issue / close / reopen).
 *              Always propose unless covered by a live mutate window.
 *              A live append window does NOT satisfy a mutate write.
 *
 * requireWriteGate() returns:
 *   { status: 'approved', token, singleProposalId }  — proceed with the write
 *   { status: 'pending', proposalId }                — human must approve first
 *
 * The gate is fail-closed:
 *   1. requireGrantAndToken() still throws on no grant / no credential.
 *   2. If no live approval row exists → insert pending proposal, emit
 *      action.proposed, return pending (never throws; caller surfaces to agent).
 *   3. Global write ceiling exceeded even inside a live window → re-propose.
 *
 * Security invariants:
 * - Fail-closed: no grant OR no sealed credential ⇒ throw.
 * - Tokens/PAT are NEVER logged, NEVER returned to callers, NEVER echoed.
 * - Per-DID isolation: `github-pat:${did}`, `github-oauth:${did}`, `github-config:${did}`.
 */
import { nanoid } from 'nanoid';
import { and, eq, gt, sql } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import * as bus from '@imajin/bus';
import { db, githubActionProposals } from '@/src/db';
import { sealAndStore, loadAndUnseal } from '@/src/lib/vault';
import { createConnectorOAuth, type BaseOAuthConfig, type OAuthTokenResponse } from '../kernel/connector-oauth';

const log = createLogger('kernel');

/** Connector app DID — matches the scope-manifest fixture (github-scope-manifest.md). */
export const GITHUB_CONNECTOR_DID = 'did:imajin:github-connector';

/** GitHub REST API constants. */
const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

/**
 * GitHub OAuth scope requested at authorize time — a GitHub scope string,
 * distinct from the imajin channel scopes (github:read / github:write).
 */
export const GITHUB_OAUTH_SCOPE = 'repo';

// ── GitHub-specific types ─────────────────────────────────────────────────────────

/** GitHub OAuth app config (no `environment` field — GitHub has one API). */
export interface GitHubConfig extends BaseOAuthConfig {}

export interface GitHubTokens {
  accessToken: string;
  /** Present only when the OAuth App has token expiration enabled. */
  refreshToken?: string;
  /** GitHub scope string granted to the token. */
  scope?: string;
  /** epoch ms at which the access token expires; absent for non-expiring tokens. */
  expiresAt?: number;
}

// ── Factory ───────────────────────────────────────────────────────────────────────────

const gh = createConnectorOAuth<GitHubConfig, GitHubTokens>({
  name: 'github',
  configPrefix: 'github-config',
  tokenPrefix: 'github-oauth',
  connectorDid: GITHUB_CONNECTOR_DID,
  channel: 'github',
  authorizeUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  oauthScope: GITHUB_OAUTH_SCOPE,
  // GitHub uses client credentials in the POST body (not HTTP Basic).
  tokenAuth: 'body',
  parseConfig: (raw) => raw as GitHubConfig,
  buildTokens: (data: OAuthTokenResponse, _extra, previous) => ({
    accessToken: data.access_token as string,
    // GitHub rotates refresh tokens on expiring-token apps; keep the newest.
    refreshToken: (data.refresh_token as string | undefined) ?? previous?.refreshToken,
    scope: (data.scope as string | undefined) ?? previous?.scope,
    // Default GitHub OAuth Apps issue non-expiring tokens (no expires_in).
    expiresAt: typeof data.expires_in === 'number' ? Date.now() + data.expires_in * 1000 : undefined,
  }),
  // Only refresh when the app issues expiring tokens (both fields present).
  shouldRefresh: (tokens) =>
    tokens.refreshToken !== undefined &&
    tokens.expiresAt !== undefined &&
    Date.now() >= tokens.expiresAt - 60_000,
});

// ── Public exports (shared interface unchanged) ─────────────────────────────────

/** Per-DID vault field for a GitHub PAT (separate from the OAuth bundle). */
export function vaultField(ownerDid: string): string {
  return `github-pat:${ownerDid}`;
}

export const configField = gh.configField;
export const oauthVaultField = gh.tokenField;
export const storeConfig = gh.storeConfig;
export const buildAuthorizeUrl = gh.buildAuthorizeUrl;
export const exchangeCodeAndStore = gh.exchangeCodeAndStore;
export const resolveActiveGrant = gh.resolveActiveGrant;

/**
 * Seal and store a GitHub PAT for the given DID. The PAT is never logged or
 * returned; the only observable output is the sealed VaultEntry.
 */
export async function sealPat(ownerDid: string, pat: string): Promise<void> {
  await sealAndStore(vaultField(ownerDid), pat);
}

// ── Rate-limit constants (tune-later per #1366 child-5) ──────────────────────────

/** Hard cap on done writes per owner per rolling hour — enforced even inside live windows. */
const GLOBAL_WRITE_CEILING_PER_HOUR = 30;

// ── Gate helper ──────────────────────────────────────────────────────────────────

/**
 * Resolve the connector grant and a usable bearer token. Prefers the OAuth
 * access token (refreshed ahead of expiry when the app issues expiring tokens)
 * and falls back to the sealed PAT. Fail-closed on both gates.
 *
 * Throws:
 *   - `github_no_grant`      — no active channel_links row for ownerDid + scope.
 *   - `github_no_credential` — no sealed OAuth bundle and no sealed PAT.
 */
async function requireGrantAndToken(ownerDid: string, scope: string): Promise<string> {
  const hasGrant = await gh.resolveActiveGrant(ownerDid, scope);
  if (!hasGrant) {
    throw new Error(
      `github_no_grant: DID ${ownerDid} has no active '${scope}' grant — ` +
      `edit the scope-manifest to enable this connector scope`,
    );
  }

  const oauthToken = await gh.loadAccessToken(ownerDid);
  if (oauthToken !== undefined) return oauthToken;

  const pat = await loadAndUnseal(vaultField(ownerDid));
  if (pat === undefined) {
    throw new Error(
      `github_no_credential: no GitHub OAuth token or PAT sealed for DID ${ownerDid} — ` +
      `authorize via /github/api/connect or use github_connect first`,
    );
  }
  return pat;
}

// ── Confirm rail + append/mutate tiering (#1366, #1370) ──────────────────────────

/**
 * Shared result type for both append- and mutate-tier write gates.
 *
 * - `approved`: write may proceed; `token` is the bearer token;
 *   `singleProposalId` is non-null only for single-call approvals (mark done after write).
 * - `pending`: no live approval grant; proposal recorded, action.proposed published.
 */
export type WriteGateResult =
  | { status: 'approved'; token: string; singleProposalId: string | null }
  | { status: 'pending'; proposalId: string };

/** Alias kept for backward compatibility with existing call sites. */
export type MutateGateResult = WriteGateResult;

/**
 * The discriminated-union result returned from all write operations.
 * The MCP tool handler checks `status` before building its response.
 */
export type GitHubWriteResult<T> =
  | { status: 'done'; data: T }
  | { status: 'pending'; proposalId: string; message: string };

/** Count done writes for ownerDid in the last `windowHours` hours (rate-limit check). */
async function countDoneProposals(ownerDid: string, windowHours: number): Promise<number> {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(githubActionProposals)
    .where(
      and(
        eq(githubActionProposals.ownerDid, ownerDid),
        eq(githubActionProposals.status, 'done'),
        gt(githubActionProposals.createdAt, cutoff),
      ),
    );
  return rows[0]?.count ?? 0;
}

/** Insert a 'done' row for rate-limit accounting under a windowed approval. */
async function insertDoneRow(
  ownerDid: string,
  scope: string,
  tool: string,
  riskTier: 'append' | 'mutate',
  target: string,
  argsSummary: string,
  agentDid?: string,
): Promise<string> {
  const id = `proposal_${nanoid()}`;
  await db.insert(githubActionProposals).values({
    id,
    ownerDid,
    agentDid: agentDid ?? null,
    scope,
    tool,
    riskTier,
    target,
    argsSummary,
    status: 'done',
  });
  return id;
}

/**
 * Shared write gate used by both append- and mutate-tier operations.
 * NEVER throws for the pending case — it is a valid expected outcome.
 *
 * Flow:
 * 1. Look for a live 'approved' row matching ownerDid + scope + riskTier.
 *    An append-approved row does NOT satisfy a mutate lookup, and vice versa.
 * 2. Check the global write ceiling — enforced even inside a live window.
 * 3a. Ceiling ok + live grant:  return approved (insert done row if windowed).
 * 3b. No live grant OR ceiling exceeded:  insert pending proposal, publish
 *     action.proposed with the correct risk field, return pending.
 */
async function requireWriteGate(
  ownerDid: string,
  scope: string,
  tool: string,
  risk: 'append' | 'mutate',
  target: string,
  argsSummary: string,
  token: string,
  agentDid?: string,
): Promise<WriteGateResult> {
  // ── 1. Look for a live approval grant for this exact risk tier ────────────
  const now = new Date();
  const liveGrants = await db
    .select()
    .from(githubActionProposals)
    .where(
      and(
        eq(githubActionProposals.ownerDid, ownerDid),
        eq(githubActionProposals.scope, scope),
        eq(githubActionProposals.riskTier, risk),
        eq(githubActionProposals.status, 'approved'),
      ),
    )
    .limit(1);

  const liveGrant = liveGrants[0];
  const isLive =
    liveGrant !== undefined &&
    (liveGrant.approvedUntil === null || liveGrant.approvedUntil > now);

  // ── 2. Global write ceiling check ────────────────────────────────────────
  const recentDone = await countDoneProposals(ownerDid, 1);
  const ceilingExceeded = recentDone >= GLOBAL_WRITE_CEILING_PER_HOUR;

  if (isLive && !ceilingExceeded) {
    // ── 3a. Approved path ─────────────────────────────────────────────────
    if (liveGrant!.approvedUntil !== null) {
      // Windowed: insert a done row for rate counting; leave the grant active.
      await insertDoneRow(ownerDid, scope, tool, risk, target, argsSummary, agentDid);
      return { status: 'approved', token, singleProposalId: null };
    }
    // Single-call: the grant row itself becomes 'done' after the write.
    return { status: 'approved', token, singleProposalId: liveGrant!.id };
  }

  // ── 3b. Pending path: insert proposal + emit action.proposed ─────────────
  const proposalId = `proposal_${nanoid()}`;
  const effectiveSummary = ceilingExceeded ? `[RATE_LIMIT] ${argsSummary}` : argsSummary;
  await db.insert(githubActionProposals).values({
    id: proposalId,
    ownerDid,
    agentDid: agentDid ?? null,
    scope,
    tool,
    riskTier: risk,
    target,
    argsSummary: effectiveSummary,
    status: 'pending',
  });

  try {
    await bus.publish('action.proposed', {
      issuer: ownerDid,
      subject: ownerDid,
      scope: 'github',
      payload: {
        proposalId,
        ownerDid,
        agentDid,
        scope,
        tool,
        risk,
        target,
        argsSummary: effectiveSummary,
        context_id: proposalId,
        context_type: 'github' as const,
      },
    });
  } catch (err) {
    log.error({ err: String(err), proposalId, tool, risk }, 'action.proposed publish failed (non-fatal)');
  }

  const reason = ceilingExceeded
    ? `Global write ceiling (${GLOBAL_WRITE_CEILING_PER_HOUR}/hr) exceeded — re-raised to human even inside active window`
    : `No live ${risk}-tier approval grant — human confirmation required`;
  log.info({ proposalId, ownerDid, tool, target, risk, ceilingExceeded }, reason);

  return { status: 'pending', proposalId };
}

/**
 * Public wrapper: confirm gate for append-tier writes (create_issue, create_comment).
 * Queries only for risk_tier='append' — a live mutate window does NOT satisfy this.
 */
export async function requireAppendGate(
  ownerDid: string,
  scope: string,
  tool: string,
  target: string,
  argsSummary: string,
  token: string,
  agentDid?: string,
): Promise<WriteGateResult> {
  return requireWriteGate(ownerDid, scope, tool, 'append', target, argsSummary, token, agentDid);
}

/**
 * Public wrapper: confirm gate for mutate-tier writes (update_issue / close / reopen).
 * Queries only for risk_tier='mutate' — a live append window does NOT satisfy this.
 */
export async function requireMutateGate(
  ownerDid: string,
  scope: string,
  tool: string,
  target: string,
  argsSummary: string,
  token: string,
  agentDid?: string,
): Promise<WriteGateResult> {
  return requireWriteGate(ownerDid, scope, tool, 'mutate', target, argsSummary, token, agentDid);
}

/**
 * Mark a single-call approval proposal as 'done' and emit action.done.
 * Called after the API write succeeds to close out the proposal lifecycle.
 */
export async function markProposalDone(
  proposalId: string,
  ownerDid: string,
  tool: string,
  target: string,
): Promise<void> {
  await db
    .update(githubActionProposals)
    .set({ status: 'done', updatedAt: new Date() })
    .where(
      and(
        eq(githubActionProposals.id, proposalId),
        eq(githubActionProposals.ownerDid, ownerDid),
      ),
    );

  try {
    await bus.publish('action.done', {
      issuer: ownerDid,
      subject: ownerDid,
      scope: 'github',
      payload: {
        proposalId,
        ownerDid,
        tool,
        target,
        context_id: proposalId,
        context_type: 'github' as const,
      },
    });
  } catch (err) {
    log.error({ err: String(err), proposalId }, 'action.done publish failed (non-fatal)');
  }
}

// ── GitHub REST API helper ─────────────────────────────────────────────

interface GitHubApiOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  token: string;
  body?: Record<string, unknown>;
}

/**
 * Call the GitHub REST API. Throws a descriptive error on non-2xx responses.
 *
 * The bearer token (OAuth access token or PAT) is only used in the Authorization
 * header; it is never logged. The returned value is the parsed JSON response body.
 */
async function callGitHubApi(opts: Readonly<GitHubApiOptions>): Promise<unknown> {
  const url = `${GITHUB_API_BASE}${opts.path}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${opts.token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': 'imajin-mcp/1.0',
  };

  const init: RequestInit = { method: opts.method, headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }

  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitHub API error ${res.status} ${res.statusText}: ${text}`);
  }

  return res.json() as Promise<unknown>;
}

// ── Public GitHub actions ─────────────────────────────────────────────────────

export interface GitHubIssue {
  number: number;
  html_url: string;
  title: string;
  state: string;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
  updated_at: string;
}

export interface GitHubComment {
  id: number;
  html_url: string;
  body: string;
  user: { login: string } | null;
  created_at: string;
}

/**
 * Create a GitHub issue on behalf of ownerDid (append tier — confirm rail required).
 *
 * Gates:
 *  1. active `github:write` channel_links row + sealed credential (fail-closed, throws).
 *  2. requireAppendGate() confirm rail (fail-pending on no live append-approval).
 *
 * Returns GitHubWriteResult<GitHubIssue>:
 *  - { status: 'done', data }    — write executed; action.done emitted.
 *  - { status: 'pending', ... }  — proposal recorded; action.proposed emitted.
 */
export async function createIssue(
  ownerDid: string,
  repo: string,
  title: string,
  body: string,
): Promise<GitHubWriteResult<GitHubIssue>> {
  // Step 1: credential gate (fail-closed — throws on no grant / no credential).
  const token = await requireGrantAndToken(ownerDid, 'github:write');

  const target = repo;
  const argsSummary = `create_issue ${repo}: "${title.slice(0, 80)}"`;

  // Step 2: append confirm gate.
  const gate = await requireAppendGate(
    ownerDid, 'github:write', 'github_create_issue', target, argsSummary, token,
  );

  if (gate.status === 'pending') {
    return {
      status: 'pending',
      proposalId: gate.proposalId,
      message:
        `Action proposed (proposalId: ${gate.proposalId}). ` +
        `Approve at /github/api/confirm/${gate.proposalId} then retry this tool call.`,
    };
  }

  // Step 3: execute the write.
  const data = await callGitHubApi({
    method: 'POST',
    path: `/repos/${repo}/issues`,
    token: gate.token,
    body: { title, body },
  }) as GitHubIssue;

  // Step 4: attribution bus event (non-fatal).
  try {
    await bus.publish('github.issue.created', {
      issuer: ownerDid,
      subject: ownerDid,
      scope: 'github',
      payload: {
        ownerDid,
        repo,
        issueNumber: data.number,
        issueUrl: data.html_url,
        context_id: String(data.number),
        context_type: 'github' as const,
      },
    });
  } catch (err) {
    log.error({ err: String(err), repo, issueNumber: data.number }, 'github.issue.created publish failed (non-fatal)');
  }

  // Step 5: close out the proposal lifecycle.
  if (gate.singleProposalId !== null) {
    await markProposalDone(gate.singleProposalId, ownerDid, 'github_create_issue', target);
  } else {
    try {
      await bus.publish('action.done', {
        issuer: ownerDid,
        subject: ownerDid,
        scope: 'github',
        payload: {
          proposalId: 'windowed',
          ownerDid,
          tool: 'github_create_issue',
          target,
          context_id: target,
          context_type: 'github' as const,
        },
      });
    } catch (err) {
      log.error({ err: String(err), target }, 'action.done (windowed) publish failed (non-fatal)');
    }
  }

  return { status: 'done', data };
}

/**
 * Create a GitHub issue comment on behalf of ownerDid (append tier — confirm rail required).
 *
 * Gates:
 *  1. active `github:write` channel_links row + sealed credential (fail-closed, throws).
 *  2. requireAppendGate() confirm rail (fail-pending on no live append-approval).
 *
 * Returns GitHubWriteResult<GitHubComment>:
 *  - { status: 'done', data }    — write executed; action.done emitted.
 *  - { status: 'pending', ... }  — proposal recorded; action.proposed emitted.
 */
export async function createComment(
  ownerDid: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<GitHubWriteResult<GitHubComment>> {
  // Step 1: credential gate (fail-closed — throws on no grant / no credential).
  const token = await requireGrantAndToken(ownerDid, 'github:write');

  const target = `${repo}#${issueNumber}`;
  const argsSummary = `create_comment ${target}: "${body.slice(0, 60)}"`;

  // Step 2: append confirm gate.
  const gate = await requireAppendGate(
    ownerDid, 'github:write', 'github_create_comment', target, argsSummary, token,
  );

  if (gate.status === 'pending') {
    return {
      status: 'pending',
      proposalId: gate.proposalId,
      message:
        `Action proposed (proposalId: ${gate.proposalId}). ` +
        `Approve at /github/api/confirm/${gate.proposalId} then retry this tool call.`,
    };
  }

  // Step 3: execute the write.
  const data = await callGitHubApi({
    method: 'POST',
    path: `/repos/${repo}/issues/${issueNumber}/comments`,
    token: gate.token,
    body: { body },
  }) as GitHubComment;

  // Step 4: attribution bus event (non-fatal).
  try {
    await bus.publish('github.comment.created', {
      issuer: ownerDid,
      subject: ownerDid,
      scope: 'github',
      payload: {
        ownerDid,
        repo,
        issueNumber,
        commentId: data.id,
        commentUrl: data.html_url,
        context_id: String(data.id),
        context_type: 'github' as const,
      },
    });
  } catch (err) {
    log.error({ err: String(err), repo, issueNumber, commentId: data.id }, 'github.comment.created publish failed (non-fatal)');
  }

  // Step 5: close out the proposal lifecycle.
  if (gate.singleProposalId !== null) {
    await markProposalDone(gate.singleProposalId, ownerDid, 'github_create_comment', target);
  } else {
    try {
      await bus.publish('action.done', {
        issuer: ownerDid,
        subject: ownerDid,
        scope: 'github',
        payload: {
          proposalId: 'windowed',
          ownerDid,
          tool: 'github_create_comment',
          target,
          context_id: target,
          context_type: 'github' as const,
        },
      });
    } catch (err) {
      log.error({ err: String(err), target }, 'action.done (windowed) publish failed (non-fatal)');
    }
  }

  return { status: 'done', data };
}

/**
 * List GitHub issues for a repo on behalf of ownerDid.
 *
 * Gates: active `github:read` channel_links row + sealed PAT.
 */
export async function listIssues(
  ownerDid: string,
  repo: string,
  state: 'open' | 'closed' | 'all' = 'open',
): Promise<GitHubIssue[]> {
  const token = await requireGrantAndToken(ownerDid, 'github:read');

  return callGitHubApi({
    method: 'GET',
    path: `/repos/${repo}/issues?state=${state}&per_page=50`,
    token,
  }) as Promise<GitHubIssue[]>;
}

/**
 * Get a single GitHub issue on behalf of ownerDid.
 *
 * Gates: active `github:read` channel_links row + sealed PAT.
 */
export async function getIssue(
  ownerDid: string,
  repo: string,
  issueNumber: number,
): Promise<GitHubIssue> {
  const token = await requireGrantAndToken(ownerDid, 'github:read');

  return callGitHubApi({
    method: 'GET',
    path: `/repos/${repo}/issues/${issueNumber}`,
    token,
  }) as Promise<GitHubIssue>;
}

export interface GitHubUpdateIssueParams {
  title?: string;
  body?: string;
  state?: 'open' | 'closed';
}

/**
 * Update a GitHub issue on behalf of ownerDid (mutate tier — confirm rail required).
 *
 * Gates:
 *  1. active `github:write` channel_links row + sealed credential (fail-closed, throws).
 *  2. requireMutateGate() confirm rail (fail-pending on no live approval).
 *
 * Returns GitHubWriteResult<GitHubIssue>:
 *  - { status: 'done', data }    — write executed; action.done emitted.
 *  - { status: 'pending', ... }  — proposal recorded; action.proposed emitted.
 *                                  The MCP tool must surface this to the agent.
 *
 * Both append-tier tools (createIssue / createComment) are now gated via requireAppendGate().
 * Per-tool sub-limits (#1371) will hook into countDoneProposals with a tool filter.
 */
export async function updateIssue(
  ownerDid: string,
  repo: string,
  issueNumber: number,
  updates: GitHubUpdateIssueParams,
  agentDid?: string,
): Promise<GitHubWriteResult<GitHubIssue>> {
  // Step 1: credential gate (fail-closed — throws on no grant / no credential).
  const token = await requireGrantAndToken(ownerDid, 'github:write');

  const target = `${repo}#${issueNumber}`;
  const parts: string[] = [];
  if (updates.title !== undefined) parts.push(`title="${updates.title}"`);
  if (updates.body !== undefined) parts.push('body=[set]');
  if (updates.state !== undefined) parts.push(`state=${updates.state}`);
  const argsSummary = `update_issue ${target} ${parts.join(', ')}`;

  // Step 2: confirm gate (returns approved or pending — never throws for pending).
  const gate = await requireMutateGate(
    ownerDid,
    'github:write',
    'github_update_issue',
    target,
    argsSummary,
    token,
    agentDid,
  );

  if (gate.status === 'pending') {
    return {
      status: 'pending',
      proposalId: gate.proposalId,
      message:
        `Action proposed (proposalId: ${gate.proposalId}). ` +
        `Approve at /github/api/confirm/${gate.proposalId} then retry this tool call.`,
    };
  }

  // Step 3: execute the write.
  const patchBody: Record<string, unknown> = {};
  if (updates.title !== undefined) patchBody.title = updates.title;
  if (updates.body !== undefined) patchBody.body = updates.body;
  if (updates.state !== undefined) patchBody.state = updates.state;

  const data = await callGitHubApi({
    method: 'PATCH',
    path: `/repos/${repo}/issues/${issueNumber}`,
    token: gate.token,
    body: patchBody,
  }) as GitHubIssue;

  // Step 4: close out the single-call approval and emit action.done.
  if (gate.singleProposalId !== null) {
    await markProposalDone(gate.singleProposalId, ownerDid, 'github_update_issue', target);
  } else {
    // Windowed: done row already inserted by requireMutateGate(); just emit.
    try {
      await bus.publish('action.done', {
        issuer: ownerDid,
        subject: ownerDid,
        scope: 'github',
        payload: {
          proposalId: 'windowed',
          ownerDid,
          tool: 'github_update_issue',
          target,
          context_id: target,
          context_type: 'github' as const,
        },
      });
    } catch (err) {
      log.error({ err: String(err), target }, 'action.done (windowed) publish failed (non-fatal)');
    }
  }

  return { status: 'done', data };
}
