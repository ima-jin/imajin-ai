/**
 * GitHub connector backend library (#1228, Stage B2).
 *
 * Connects a human DID's GitHub PAT (sealed in imajin-vault) to the GitHub
 * REST API, gated by an active `auth.channel_links` row for the github
 * connector app DID + the required scope.
 *
 * Custody disclosure: the PAT is sealed with the node's AES-256-GCM seal key
 * (node-sealed v1). The node operator can decrypt it. Zero-custody migration
 * is tracked under a later hardening issue.
 *
 * ── Security invariants ───────────────────────────────────────────────────────
 * - Fail-closed on every gate: no active grant OR no sealed PAT ⇒ throw.
 * - PAT is NEVER logged, NEVER returned to callers, NEVER echoed.
 * - Per-DID vault field isolation: `github-pat:${ownerDid}`.
 * - Cross-DID reads are structurally impossible: `loadAndUnseal` uses the
 *   node's signing identity for integrity; the field name encodes the owner DID.
 *
 * ── Attribution ───────────────────────────────────────────────────────────────
 * After each successful GitHub mutation, a `github.issue.created` /
 * `github.comment.created` bus event is published non-fatally (mirroring
 * the `asset.article.published` pattern in media-write.ts).
 */
import { createLogger } from '@imajin/logger';
import * as bus from '@imajin/bus';
import { and, eq } from 'drizzle-orm';
import { db, channelLinks } from '@/src/db';
import { sealAndStore, loadAndUnseal } from '@/src/lib/vault';

const log = createLogger('kernel');

/** Connector app DID — matches the scope-manifest fixture (github-scope-manifest.md). */
export const GITHUB_CONNECTOR_DID = 'did:imajin:github-connector';

/** Channel name — matches the scope-manifest fixture `channel:` field. */
const GITHUB_CHANNEL = 'github';

/** GitHub REST API base URL. */
const GITHUB_API_BASE = 'https://api.github.com';

/** GitHub API version header per GitHub's REST API versioning docs. */
const GITHUB_API_VERSION = '2022-11-28';

// ── Vault field helpers ───────────────────────────────────────────────────────

/**
 * Per-DID vault field name for a GitHub PAT.
 *
 * Encoding the ownerDid in the field name ensures per-DID isolation at the
 * vault layer: different DIDs cannot share or cross-read each other's PATs.
 */
export function vaultField(ownerDid: string): string {
  return `github-pat:${ownerDid}`;
}

/**
 * Seal and store a GitHub PAT for the given DID.
 *
 * Uses v1 node-sealed storage (sealAndStore). The plaintext PAT is never
 * logged or returned; the only observable output is the sealed VaultEntry.
 *
 * Callers (github_connect tool) must ensure the PAT string has been validated
 * (non-empty) before calling; this function does not validate PAT format.
 */
export async function sealPat(ownerDid: string, pat: string): Promise<void> {
  await sealAndStore(vaultField(ownerDid), pat);
}

// ── Grant resolution ──────────────────────────────────────────────────────────

/**
 * Check whether an active `channel_links` row exists for this DID + scope.
 *
 * An active row is created by the scope-manifest projection surface when the
 * owner grants the scope via their scope-manifest asset (#1209/#1204). The
 * row is revoked (status → 'revoked') when the scope is deleted from the
 * manifest or the manifest asset is deleted.
 *
 * Returns `true` only when at least one ACTIVE row for the github channel
 * and the github connector app DID contains the requested scope.
 * Fail-closed: any DB error propagates as a thrown exception.
 */
export async function resolveActiveGrant(ownerDid: string, requiredScope: string): Promise<boolean> {
  const rows = await db
    .select({ scopes: channelLinks.scopes })
    .from(channelLinks)
    .where(
      and(
        eq(channelLinks.channel, GITHUB_CHANNEL),
        eq(channelLinks.did, ownerDid),
        eq(channelLinks.appDid, GITHUB_CONNECTOR_DID),
        eq(channelLinks.status, 'active'),
      ),
    );

  return rows.some((row) => {
    const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
    return scopes.includes(requiredScope);
  });
}

// ── Gate helper ───────────────────────────────────────────────────────────────

/**
 * Resolve the connector grant and unseal the PAT. Fail-closed on both gates.
 *
 * This is the single mandatory entry point for all GitHub mutation tools.
 * The resolved PAT is returned only to the calling scope; it must not be
 * logged, stored in plaintext, or returned to external callers.
 *
 * Throws:
 *   - `github_no_grant` — no active channel_links row for ownerDid + scope.
 *   - `github_no_pat`   — no sealed PAT in the vault for ownerDid.
 *   - Any vault integrity error from loadAndUnseal.
 */
async function requireGrantAndPat(ownerDid: string, scope: string): Promise<string> {
  const hasGrant = await resolveActiveGrant(ownerDid, scope);
  if (!hasGrant) {
    throw new Error(
      `github_no_grant: DID ${ownerDid} has no active '${scope}' grant — ` +
      `edit the scope-manifest to enable this connector scope`,
    );
  }

  const pat = await loadAndUnseal(vaultField(ownerDid));
  if (pat === undefined) {
    throw new Error(
      `github_no_pat: no GitHub PAT sealed for DID ${ownerDid} — ` +
      `use github_connect to store a PAT first`,
    );
  }

  return pat;
}

// ── GitHub REST API helper ────────────────────────────────────────────────────

interface GitHubApiOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  pat: string;
  body?: Record<string, unknown>;
}

/**
 * Call the GitHub REST API. Throws a descriptive error on non-2xx responses.
 *
 * The PAT is only used in the Authorization header; it is never logged.
 * The returned value is the parsed JSON response body.
 */
async function callGitHubApi(opts: Readonly<GitHubApiOptions>): Promise<unknown> {
  const url = `${GITHUB_API_BASE}${opts.path}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${opts.pat}`,
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
  const pat = await requireGrantAndPat(ownerDid, 'github:write');

  const data = await callGitHubApi({
    method: 'POST',
    path: `/repos/${repo}/issues`,
    pat,
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
  const pat = await requireGrantAndPat(ownerDid, 'github:write');

  const data = await callGitHubApi({
    method: 'POST',
    path: `/repos/${repo}/issues/${issueNumber}/comments`,
    pat,
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
  const pat = await requireGrantAndPat(ownerDid, 'github:read');

  return callGitHubApi({
    method: 'GET',
    path: `/repos/${repo}/issues?state=${state}&per_page=50`,
    pat,
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
  const pat = await requireGrantAndPat(ownerDid, 'github:read');

  return callGitHubApi({
    method: 'GET',
    path: `/repos/${repo}/issues/${issueNumber}`,
    pat,
  }) as Promise<GitHubIssue>;
}
