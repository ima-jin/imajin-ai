/**
 * GitHub connector backend library (#1228, Stage B2; OAuth2 #1333).
 *
 * Connects a human DID's GitHub account (OAuth2 or PAT fallback) to the
 * GitHub REST API, gated by an active `auth.channel_links` row. The OAuth2
 * plumbing is provided by `createConnectorOAuth` (#1333); only GitHub-specific
 * details live here: the repo scope, body-param token auth, optional-expiry
 * token shape, PAT fallback, and issue/comment bus events.
 *
 * Security invariants:
 * - Fail-closed: no grant OR no sealed credential ⇒ throw.
 * - Tokens/PAT are NEVER logged, NEVER returned to callers, NEVER echoed.
 * - Per-DID isolation: `github-pat:${did}`, `github-oauth:${did}`, `github-config:${did}`.
 */
import { createLogger } from '@imajin/logger';
import * as bus from '@imajin/bus';
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
 * Create a GitHub issue on behalf of ownerDid.
 *
 * Gates: active `github:write` channel_links row + sealed PAT.
 * Attribution: publishes `github.issue.created` bus event (non-fatal).
 */
export async function createIssue(
  ownerDid: string,
  repo: string,
  title: string,
  body: string,
): Promise<GitHubIssue> {
  const token = await requireGrantAndToken(ownerDid, 'github:write');

  const data = await callGitHubApi({
    method: 'POST',
    path: `/repos/${repo}/issues`,
    token,
    body: { title, body },
  }) as GitHubIssue;

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

  return data;
}

/**
 * Create a GitHub issue comment on behalf of ownerDid.
 *
 * Gates: active `github:write` channel_links row + sealed PAT.
 * Attribution: publishes `github.comment.created` bus event (non-fatal).
 */
export async function createComment(
  ownerDid: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<GitHubComment> {
  const token = await requireGrantAndToken(ownerDid, 'github:write');

  const data = await callGitHubApi({
    method: 'POST',
    path: `/repos/${repo}/issues/${issueNumber}/comments`,
    token,
    body: { body },
  }) as GitHubComment;

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

  return data;
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
