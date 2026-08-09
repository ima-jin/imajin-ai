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
 *   { status: 'approved', token, singleProposalId }             — proceed with the write
 *   { status: 'pending', proposalId, reason, limitLabel }       — human must approve first
 *
 * `reason` distinguishes WHY a write is pending (#1716):
 *   'no_grant'     — no live approval window at all; approving now unblocks it.
 *   'rate_limited' — a live window IS active, but a ceiling tripped anyway; approving
 *                    again opens ANOTHER window and does NOT lift the ceiling — the
 *                    write only unblocks once the ceiling's rolling window clears.
 * Callers must forward `reason`/`limitLabel` into `pendingApprovalMessage()` so the
 * agent/human is told the difference — conflating the two reads as "approving did
 * nothing", i.e. "the window only fires once" (#1716).
 *
 * The gate is fail-closed:
 *   1. requireGrantAndToken() still throws on no grant / no credential.
 *   2. If no live approval row exists → insert pending proposal, emit
 *      action.proposed, return pending (never throws; caller surfaces to agent).
 *   3. Global write ceiling exceeded even inside a live window → re-propose.
 *
 * Approval liveness is resolved by scanning the approved rows for the
 * (ownerDid, scope, riskTier) tuple newest-first and retiring any whose window
 * has lapsed — see requireWriteGate() and retireLapsedApprovals() for why a
 * bare `limit(1)` was unsound (#1588).
 *
 * ── Read depth (#1528) ────────────────────────────────────────────────────────
 * All list verbs (listIssues / listPullRequests / listComments / searchIssues)
 * walk `Link: rel="next"` via collectPaginated() and return a
 * GitHubListResult<T> whose `hasMore` says whether results were left behind.
 * Silent truncation is the bug being fixed: a caller that cannot distinguish
 * "all of them" from "the first N" will confidently draw wrong conclusions.
 * Every read verb stays on `github:read` — no new scopes, no confirm rail.
 *
 * Security invariants:
 * - Fail-closed: no grant OR no sealed credential ⇒ throw.
 * - Tokens/PAT are NEVER logged, NEVER returned to callers, NEVER echoed.
 * - Per-DID isolation: `github-pat:${did}`, `github-oauth:${did}`, `github-config:${did}`.
 */
import { nanoid } from 'nanoid';
import { and, desc, eq, gt, isNotNull, lte, sql } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import * as bus from '@imajin/bus';
import { db, githubActionProposals } from '@/src/db';
import { sealAndStoreV2, loadAndUnseal } from '@/src/lib/vault';
import { VaultDelegationError } from '@/src/lib/vault/errors';
import {
  createConnectorOAuth,
  resolveOAuthFlow,
  ConnectorCredentialPendingError,
  type BaseOAuthConfig,
  type OAuthFlow,
  type OAuthTokenResponse,
} from '../kernel/connector-oauth';
import { readReadAllowlist, filterOrgs, filterRepos, isRepoAllowed } from './allowlist';
import { GITHUB_CONNECTOR_DID } from './constants';
import { pendingApprovalMessage } from './pending-message';
import {
  isPullRequest,
  normalizeLimit,
  parseNextLink,
  withPerPage,
  MAX_PAGES_PER_LIST,
  type GitHubComment,
  type GitHubIssue,
  type GitHubIssueType,
  type GitHubListResult,
  type GitHubPullRequest,
  type PaginatedCollection,
} from './entities';

const log = createLogger('kernel');

// Re-exported for backwards compatibility; the value lives in the leaf
// `./constants` module so `./scope-manifest` can read it without importing this
// module (which would re-form the connector → allowlist → scope-manifest cycle).
export { GITHUB_CONNECTOR_DID } from './constants';

// Entity shapes and pagination primitives live in the I/O-free `./entities` leaf
// (#1528) so the MCP tool layer and its tests can use them without dragging in
// the DB/vault/bus. Re-exported here so `./connector` stays a valid single
// import surface — same arrangement as `./allowlist` → `./allowlist-match`.
export {
  labelNames,
  isPullRequest,
  normalizeLimit,
  parseNextLink,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
} from './entities';
export type {
  GitHubComment,
  GitHubIssue,
  GitHubIssueType,
  GitHubLabel,
  GitHubListResult,
  GitHubMilestone,
  GitHubPullRef,
  GitHubPullRequest,
  GitHubUserRef,
  PaginatedCollection,
} from './entities';

/** GitHub REST API constants. */
const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';

/**
 * GitHub OAuth scope requested at authorize time — a GitHub scope string,
 * distinct from the imajin channel scopes (github:read / github:write).
 */
export const GITHUB_OAUTH_SCOPE = 'repo';

/** RFC 8628 device-authorization endpoint (#1391). */
const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';

// ── GitHub-specific types ───────────────────────────────────────────────────

/**
 * GitHub OAuth app config (no `environment` field — GitHub has one API).
 *
 * Carries either shape from #1391: `clientId` alone for device flow, or the
 * full clientId + clientSecret + redirectUri triple for authorization code.
 * Always the owner's own OAuth App — there is no shared imajin app.
 */
export type GitHubConfig = BaseOAuthConfig;

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
  // Device flow is the preferred BYO path (#1391); GitHub serves both grants
  // from the same token endpoint, so only the device-code URL is extra.
  deviceCodeUrl: GITHUB_DEVICE_CODE_URL,
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

// ── Device flow (#1391) ──────────────────────────────────────────────────

export const requestDeviceCode = gh.requestDeviceCode;
export const pollDeviceTokenOnce = gh.pollDeviceTokenOnce;
export const pollDeviceTokenAndStore = gh.pollDeviceTokenAndStore;

/**
 * Which auth path this DID's sealed config is for, or null when nothing is
 * sealed yet (or the config is sealed behind a pending delegation grant).
 *
 * Read by the connectors UI so a returning owner sees the step they actually
 * configured instead of the default. Non-secret by construction — it reports
 * the flow discriminator only, never any field of the config.
 */
export async function readConfigFlow(ownerDid: string): Promise<OAuthFlow | null> {
  try {
    return resolveOAuthFlow(await gh.loadConfig(ownerDid));
  } catch (err) {
    // "Not configured" and "sealed but not yet granted" are both "no answer
    // yet" for this purpose; the status route reports those states separately.
    if (err instanceof ConnectorCredentialPendingError) return null;
    if (err instanceof Error && err.message.startsWith('github_no_config')) return null;
    throw err;
  }
}

/**
 * Seal and store a GitHub PAT for the given DID. The PAT is never logged or
 * returned; the only observable output is the sealed VaultEntry.
 */
export async function sealPat(ownerDid: string, pat: string): Promise<void> {
  await sealAndStoreV2(vaultField(ownerDid), pat);
}

// ── Rate-limit constants (tune-later per #1371) ────────────────────────────────

/** Hard cap on ALL done writes per owner per rolling hour. Enforced even inside live windows. */
const GLOBAL_WRITE_CEILING_PER_HOUR = 30;

/**
 * Per-tool sub-limits enforced within the global ceiling (#1371).
 * Each tool may have multiple entries (e.g. burst + hourly).
 * Checked in order; the first exceeded entry trips the pending path.
 *
 * All numbers are tune-later placeholders matching the #1366 epic design.
 */
const PER_TOOL_LIMITS: Record<string, ReadonlyArray<{
  /** Max `done` rows for this tool within the rolling window. */
  ceiling: number;
  /** Rolling window size in hours (use 1/60 for per-minute). */
  windowHours: number;
  /** Label used in log messages and argsSummary annotation. */
  label: string;
}>> = {
  // Additive writes — loosest, but burst-capped to prevent comment floods.
  'github_create_comment': [
    { ceiling: 10, windowHours: 1 / 60, label: '10/min burst' },
    { ceiling: 60, windowHours: 1,      label: '60/hr' },
  ],
  // Additive writes — tighter than comments; issues are higher-signal.
  'github_create_issue': [
    { ceiling: 5, windowHours: 1, label: '5/hr' },
  ],
  // Mutate writes — tightest; always require confirm anyway.
  'github_update_issue': [
    { ceiling: 20, windowHours: 1, label: '20/hr' },
  ],
};

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

  let pat: string | undefined;
  try {
    pat = await loadAndUnseal(vaultField(ownerDid));
  } catch (err) {
    if (err instanceof VaultDelegationError) {
      throw new Error(
        `github_credential_pending: GitHub PAT for DID ${ownerDid} is sealed but awaiting owner grant approval`,
      );
    }
    throw err;
  }
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
  | {
      status: 'pending';
      proposalId: string;
      /** Why this write is pending — see `pendingReason()`/module docs (#1716). */
      reason: 'no_grant' | 'rate_limited';
      /** Set only when `reason === 'rate_limited'`; the ceiling label that tripped. */
      limitLabel: string | null;
    };

/** Alias kept for backward compatibility with existing call sites. */
export type MutateGateResult = WriteGateResult;

/**
 * The discriminated-union result returned from all write operations.
 * The MCP tool handler checks `status` before building its response.
 */
export type GitHubWriteResult<T> =
  | { status: 'done'; data: T }
  | { status: 'pending'; proposalId: string; message: string };

/** Re-exported so callers outside this module can type-check the `reason` field. */
export type WriteGatePendingReason = 'no_grant' | 'rate_limited';

/**
 * Count done writes for ownerDid in the last `windowHours` hours.
 * When `tool` is provided, counts only done rows for that specific tool
 * (per-tool sub-limit check). Without `tool`, counts across all tools
 * (global ceiling check).
 */
async function countDoneProposals(
  ownerDid: string,
  windowHours: number,
  tool?: string,
): Promise<number> {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const conditions = [
    eq(githubActionProposals.ownerDid, ownerDid),
    eq(githubActionProposals.status, 'done'),
    gt(githubActionProposals.createdAt, cutoff),
    ...(tool !== undefined ? [eq(githubActionProposals.tool, tool)] : []),
  ];
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(githubActionProposals)
    .where(and(...conditions));
  return rows[0]?.count ?? 0;
}

// ── Approval liveness (#1588) ────────────────────────────────────────────────

/**
 * Max approved rows examined per gate check when resolving the live grant.
 *
 * The lookup cannot use `limit(1)`: approved rows for a tuple are a mix of live
 * and lapsed, so taking one arbitrary row can return a dead window while a live
 * approval sits right behind it (#1588). Scanning a bounded, newest-first page
 * keeps the freshest approvals always visible. Retirement keeps the real row
 * count far below this bound.
 */
const APPROVAL_SCAN_LIMIT = 50;

type ActionProposalRow = typeof githubActionProposals.$inferSelect;

/**
 * True when a windowed approval's TTL has elapsed.
 * Single-call approvals (approvedUntil IS NULL) never lapse — they are consumed
 * by the next write instead.
 */
function hasLapsed(row: Readonly<ActionProposalRow>, now: Date): boolean {
  return row.approvedUntil !== null && row.approvedUntil <= now;
}

/**
 * Pick which live approval to spend, deterministically.
 *
 * Single-call approvals win over windows: spending one retires it (the row
 * becomes 'done' after the write), whereas a window is reusable. Draining
 * single-call rows first stops them lingering as permanently-live rows. Among
 * windows the newest approval wins.
 *
 * `liveRows` must already be ordered newest-first by the caller.
 */
function pickLiveGrant(
  liveRows: ReadonlyArray<ActionProposalRow>,
): ActionProposalRow | undefined {
  return liveRows.find((row) => row.approvedUntil === null) ?? liveRows[0];
}

/**
 * Retire every windowed approval for this tuple whose TTL has lapsed (#1588).
 *
 * Nothing else in the lifecycle moves a windowed row off 'approved': each
 * execution under a window inserts a *separate* done row and deliberately
 * leaves the approval active (see requireWriteGate step 4a). So once a window
 * expires its row is stranded at 'approved' forever, where it can shadow a
 * genuinely live approval and strand the caller in an approve → retry →
 * re-propose loop.
 *
 * Retires to 'expired', NOT 'done': countDoneProposals() reads 'done' as "a
 * write executed" for rate-limit accounting, so an unused lapsed window must
 * not consume the owner's write budget.
 *
 * Best-effort — the gate partitions on expiry independently, so a failure here
 * costs cleanliness, never correctness.
 */
async function retireLapsedApprovals(
  ownerDid: string,
  scope: string,
  risk: 'append' | 'mutate',
  now: Date,
  observed: number,
): Promise<void> {
  try {
    await db
      .update(githubActionProposals)
      .set({ status: 'expired', updatedAt: now })
      .where(
        and(
          eq(githubActionProposals.ownerDid, ownerDid),
          eq(githubActionProposals.scope, scope),
          eq(githubActionProposals.riskTier, risk),
          eq(githubActionProposals.status, 'approved'),
          isNotNull(githubActionProposals.approvedUntil),
          lte(githubActionProposals.approvedUntil, now),
        ),
      );
    log.info({ ownerDid, scope, risk, observed }, 'retired lapsed windowed approvals');
  } catch (err) {
    log.error(
      { err: String(err), ownerDid, scope, risk },
      'lapsed-approval retirement failed (non-fatal)',
    );
  }
}

/**
 * Resolve the approval to spend for a (ownerDid, scope, risk) tuple, retiring
 * any lapsed windows found on the way past (#1588).
 *
 * Returns undefined when nothing live covers the write, which sends the caller
 * down the propose path.
 */
async function resolveLiveGrant(
  ownerDid: string,
  scope: string,
  risk: 'append' | 'mutate',
): Promise<ActionProposalRow | undefined> {
  // Ordered newest-first and scanned as a page rather than `limit(1)`, so a
  // lapsed window can never be picked ahead of a live approval.
  const now = new Date();
  const approvedRows = await db
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
    .orderBy(desc(githubActionProposals.createdAt), desc(githubActionProposals.id))
    .limit(APPROVAL_SCAN_LIMIT);

  const liveRows: ActionProposalRow[] = [];
  let lapsedCount = 0;
  for (const row of approvedRows) {
    if (hasLapsed(row, now)) lapsedCount += 1;
    else liveRows.push(row);
  }

  // Retire lapsed windows so they stop accumulating as dead 'approved' rows.
  // Conditional: the common path has nothing to retire and issues no write.
  if (lapsedCount > 0) {
    await retireLapsedApprovals(ownerDid, scope, risk, now, lapsedCount);
  }

  return pickLiveGrant(liveRows);
}

// ── Rate limits (#1371) ─────────────────────────────────────────────────────

/** Outcome of the ceiling checks. Both fields false/null means "within limits". */
interface WriteLimitState {
  /** Global all-tools ceiling tripped. */
  globalExceeded: boolean;
  /** Label of the first per-tool sub-limit tripped, or null. */
  toolLimitLabel: string | null;
}

/**
 * Evaluate the global write ceiling, then the per-tool sub-limits.
 * Both trip even inside a live approval window — no exceptions.
 * The global ceiling short-circuits: per-tool checks only run when it is clear.
 */
async function checkWriteLimits(ownerDid: string, tool: string): Promise<WriteLimitState> {
  const recentDone = await countDoneProposals(ownerDid, 1);
  if (recentDone >= GLOBAL_WRITE_CEILING_PER_HOUR) {
    return { globalExceeded: true, toolLimitLabel: null };
  }

  for (const limit of PER_TOOL_LIMITS[tool] ?? []) {
    const toolCount = await countDoneProposals(ownerDid, limit.windowHours, tool);
    if (toolCount >= limit.ceiling) {
      return { globalExceeded: false, toolLimitLabel: limit.label };
    }
  }

  return { globalExceeded: false, toolLimitLabel: null };
}

/** True when any ceiling tripped, so the write must be re-raised to the human. */
function anyLimitExceeded(limits: Readonly<WriteLimitState>): boolean {
  return limits.globalExceeded || limits.toolLimitLabel !== null;
}

/**
 * argsSummary prefix telling the human a limit — not a missing approval — is why
 * this write came back for confirmation. Null when no limit tripped.
 */
function limitAnnotation(limits: Readonly<WriteLimitState>): string | null {
  if (limits.globalExceeded) return '[RATE_LIMIT]';
  if (limits.toolLimitLabel !== null) return `[TOOL_RATE_LIMIT:${limits.toolLimitLabel}]`;
  return null;
}

/** Log line explaining why the gate took the propose path. */
function pendingReason(
  limits: Readonly<WriteLimitState>,
  tool: string,
  risk: 'append' | 'mutate',
): string {
  if (limits.globalExceeded) {
    return `Global write ceiling (${GLOBAL_WRITE_CEILING_PER_HOUR}/hr) exceeded — re-raised to human even inside active window`;
  }
  if (limits.toolLimitLabel !== null) {
    return `Per-tool sub-limit (${limits.toolLimitLabel}) exceeded for ${tool} — re-raised to human`;
  }
  return `No live ${risk}-tier approval grant — human confirmation required`;
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
 * 1. Scan 'approved' rows matching ownerDid + scope + riskTier, newest-first,
 *    partition them into live vs lapsed, retire the lapsed ones, and pick a
 *    live grant from the remainder.
 *    An append-approved row does NOT satisfy a mutate lookup, and vice versa.
 * 2. Check the global write ceiling (all tools, 1hr window).
 *    Trips even inside a live window — no exceptions.
 * 3. If global ok: check per-tool sub-limits from PER_TOOL_LIMITS.
 *    Trips even inside a live window.
 * 4a. Live grant + no limit exceeded: return approved.
 * 4b. No live grant OR any limit exceeded: insert pending proposal, publish
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
  // ── 1. Resolve a live approval grant for this exact risk tier ─────────────
  const liveGrant = await resolveLiveGrant(ownerDid, scope, risk);

  // ── 2 + 3. Global write ceiling, then per-tool sub-limits ────────────────
  const limits = await checkWriteLimits(ownerDid, tool);

  if (liveGrant !== undefined && !anyLimitExceeded(limits)) {
    // ── 4a. Approved path ─────────────────────────────────────────────────
    if (liveGrant.approvedUntil !== null) {
      // Windowed: insert a done row for rate counting; leave the grant active.
      await insertDoneRow(ownerDid, scope, tool, risk, target, argsSummary, agentDid);
      return { status: 'approved', token, singleProposalId: null };
    }
    // Single-call: the grant row itself becomes 'done' after the write.
    return { status: 'approved', token, singleProposalId: liveGrant.id };
  }

  // ── 4b. Pending path: insert proposal + emit action.proposed ─────────────
  const proposalId = `proposal_${nanoid()}`;
  const annotation = limitAnnotation(limits);
  const effectiveSummary = annotation !== null
    ? `${annotation} ${argsSummary}`
    : argsSummary;
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

  log.info(
    {
      proposalId, ownerDid, tool, target, risk,
      globalExceeded: limits.globalExceeded,
      toolLimitLabel: limits.toolLimitLabel,
    },
    pendingReason(limits, tool, risk),
  );

  // A live grant existed but a ceiling tripped anyway ⇒ 'rate_limited' (#1716);
  // approving this new proposal opens another window without lifting the
  // ceiling, so the caller must tell the agent/human that explicitly rather
  // than repeat the generic "no window yet" copy.
  const reason: 'no_grant' | 'rate_limited' =
    liveGrant !== undefined && anyLimitExceeded(limits) ? 'rate_limited' : 'no_grant';
  const limitLabel = limits.globalExceeded
    ? `global ${GLOBAL_WRITE_CEILING_PER_HOUR}/hr`
    : limits.toolLimitLabel;

  return { status: 'pending', proposalId, reason, limitLabel };
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
  /**
   * Either an API path (`/repos/o/r/issues`) or an absolute `https://api.github.com/...`
   * URL. The absolute form exists so a `Link: rel="next"` URL — which GitHub hands
   * back fully qualified, cursor params included — can be replayed verbatim.
   */
  path: string;
  token: string;
  body?: Record<string, unknown>;
}

/**
 * A GitHub REST response: the parsed body plus the raw headers (#1528).
 *
 * Headers are surfaced because the body alone cannot tell you whether a listing
 * is complete — that lives in `Link: rel="next"`. Returning them is what lets
 * the list verbs say "there is more" instead of silently truncating.
 */
export interface GitHubApiResponse<T> {
  data: T;
  /** Raw response headers. `undefined` only if the fetch impl omitted them. */
  headers: Headers | undefined;
}

/**
 * Call the GitHub REST API. Throws a descriptive error on non-2xx responses.
 *
 * The bearer token (OAuth access token or PAT) is only used in the Authorization
 * header; it is never logged.
 */
async function callGitHubApi<T = unknown>(
  opts: Readonly<GitHubApiOptions>,
): Promise<GitHubApiResponse<T>> {
  const url = opts.path.startsWith('http') ? opts.path : `${GITHUB_API_BASE}${opts.path}`;
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

  const data = (await res.json()) as T;
  return { data, headers: res.headers };
}

// ── Pagination (#1528) ────────────────────────────────────────────────────────

/**
 * Walk `Link: rel="next"` until `limit` kept items are collected or the pages
 * run out.
 *
 * `keep` is applied per item BEFORE the limit is counted, so a filter that drops
 * most of a page (e.g. excluding PRs from `/issues`) still fills the requested
 * limit rather than returning a short page. `extract` adapts endpoints whose
 * body is an envelope rather than a bare array (e.g. `/search/issues`).
 */
async function collectPaginated<T>(
  firstPath: string,
  token: string,
  limit: number,
  keep: (item: T) => boolean = () => true,
  extract: (data: unknown) => T[] = (data) => (Array.isArray(data) ? (data as T[]) : []),
): Promise<PaginatedCollection<T>> {
  const items: T[] = [];
  let nextUrl: string | null = withPerPage(firstPath, limit);
  let pages = 0;
  let truncated = false;

  while (nextUrl !== null && pages < MAX_PAGES_PER_LIST) {
    const { data, headers } = await callGitHubApi({ method: 'GET', path: nextUrl, token });
    pages += 1;

    for (const item of extract(data)) {
      if (!keep(item)) continue;
      if (items.length >= limit) {
        truncated = true;
        break;
      }
      items.push(item);
    }

    if (truncated) break;

    nextUrl = parseNextLink(headers);
    if (nextUrl !== null && items.length >= limit) {
      truncated = true;
      break;
    }
  }

  return { items, hasMore: truncated || nextUrl !== null, pages };
}

// ── Public GitHub actions ─────────────────────────────────────────────────────

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
      message: pendingApprovalMessage(gate.proposalId, gate.reason, gate.limitLabel),
    };
  }

  // Step 3: execute the write.
  const { data } = await callGitHubApi<GitHubIssue>({
    method: 'POST',
    path: `/repos/${repo}/issues`,
    token: gate.token,
    body: { title, body },
  });

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
      message: pendingApprovalMessage(gate.proposalId, gate.reason, gate.limitLabel),
    };
  }

  // Step 3: execute the write.
  const { data } = await callGitHubApi<GitHubComment>({
    method: 'POST',
    path: `/repos/${repo}/issues/${issueNumber}/comments`,
    token: gate.token,
    body: { body },
  });

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

/** Optional filters for `listIssues` (#1528). */
export interface ListIssuesOptions {
  state?: 'open' | 'closed' | 'all';
  /**
   * Which rows to keep. `/issues` returns issues AND pull requests; the default
   * `'issue'` drops PRs so the verb means what its name says. Use `'pr'` or
   * `'all'` to opt back in.
   */
  type?: GitHubIssueType;
  /** Max rows returned; clamped to [1, MAX_LIST_LIMIT]. Defaults to 100. */
  limit?: number;
  /** Comma-separated label names, passed through to GitHub. */
  labels?: string;
  /** Only issues updated at or after this ISO-8601 timestamp. */
  since?: string;
  sort?: 'created' | 'updated' | 'comments';
  direction?: 'asc' | 'desc';
}

/** Build the `/issues` query string from the caller's options. */
function issuesQuery(opts: Readonly<ListIssuesOptions>): string {
  const params = new URLSearchParams({ state: opts.state ?? 'open' });
  if (opts.labels !== undefined && opts.labels.length > 0) params.set('labels', opts.labels);
  if (opts.since !== undefined && opts.since.length > 0) params.set('since', opts.since);
  if (opts.sort !== undefined) params.set('sort', opts.sort);
  if (opts.direction !== undefined) params.set('direction', opts.direction);
  return params.toString();
}

/** Predicate implementing the `type` filter over the mixed `/issues` feed. */
function issueTypeFilter(type: GitHubIssueType): (issue: GitHubIssue) => boolean {
  if (type === 'all') return () => true;
  if (type === 'pr') return isPullRequest;
  return (issue) => !isPullRequest(issue);
}

/**
 * List GitHub issues for a repo on behalf of ownerDid (#1528).
 *
 * Follows `Link: rel="next"` up to `limit` rows and reports `hasMore` so a
 * caller is never handed a silently truncated page — the old behaviour (hard 50,
 * no signal, PRs mixed in) made "12 open issues" and "the first 50 of 400 rows,
 * some of which are PRs" indistinguishable.
 *
 * Gates: active `github:read` channel_links row + sealed credential.
 */
export async function listIssues(
  ownerDid: string,
  repo: string,
  options: Readonly<ListIssuesOptions> = {},
): Promise<GitHubListResult<GitHubIssue>> {
  const token = await requireGrantAndToken(ownerDid, 'github:read');

  const limit = normalizeLimit(options.limit);
  const { items, hasMore } = await collectPaginated<GitHubIssue>(
    `/repos/${repo}/issues?${issuesQuery(options)}`,
    token,
    limit,
    issueTypeFilter(options.type ?? 'issue'),
  );

  return { items, hasMore, limit };
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

  const { data } = await callGitHubApi<GitHubIssue>({
    method: 'GET',
    path: `/repos/${repo}/issues/${issueNumber}`,
    token,
  });
  return data;
}

// ── Pull requests (#1528 — read-tier) ─────────────────────────────────────────

/** Optional filters for `listPullRequests`. */
export interface ListPullRequestsOptions {
  state?: 'open' | 'closed' | 'all';
  /** Filter by base branch name (e.g. `main`). */
  base?: string;
  /** Filter by head branch, `user:ref-name` form. */
  head?: string;
  limit?: number;
  sort?: 'created' | 'updated' | 'popularity' | 'long-running';
  direction?: 'asc' | 'desc';
}

/**
 * List pull requests for a repo on behalf of ownerDid (#1528).
 *
 * Uses `/pulls` rather than filtering `/issues`, because only `/pulls` carries
 * head/base/draft/merge state — the fields that make a PR listing actionable.
 *
 * Gates: active `github:read` channel_links row + sealed credential.
 */
export async function listPullRequests(
  ownerDid: string,
  repo: string,
  options: Readonly<ListPullRequestsOptions> = {},
): Promise<GitHubListResult<GitHubPullRequest>> {
  const token = await requireGrantAndToken(ownerDid, 'github:read');

  const params = new URLSearchParams({ state: options.state ?? 'open' });
  if (options.base !== undefined && options.base.length > 0) params.set('base', options.base);
  if (options.head !== undefined && options.head.length > 0) params.set('head', options.head);
  if (options.sort !== undefined) params.set('sort', options.sort);
  if (options.direction !== undefined) params.set('direction', options.direction);

  const limit = normalizeLimit(options.limit);
  const { items, hasMore } = await collectPaginated<GitHubPullRequest>(
    `/repos/${repo}/pulls?${params.toString()}`,
    token,
    limit,
  );

  return { items, hasMore, limit };
}

/**
 * Get a single pull request on behalf of ownerDid (#1528).
 *
 * The single-PR endpoint is the only one that populates `mergeable`,
 * `mergeable_state`, and the diff counters, so "can this merge?" questions must
 * come through here rather than through `listPullRequests`.
 *
 * Gates: active `github:read` channel_links row + sealed credential.
 */
export async function getPullRequest(
  ownerDid: string,
  repo: string,
  pullNumber: number,
): Promise<GitHubPullRequest> {
  const token = await requireGrantAndToken(ownerDid, 'github:read');

  const { data } = await callGitHubApi<GitHubPullRequest>({
    method: 'GET',
    path: `/repos/${repo}/pulls/${pullNumber}`,
    token,
  });
  return data;
}

// ── Comment reads (#1528 — read-tier) ────────────────────────────────────────

/** Optional filters for `listComments`. */
export interface ListCommentsOptions {
  limit?: number;
  /** Only comments updated at or after this ISO-8601 timestamp. */
  since?: string;
  direction?: 'asc' | 'desc';
}

/**
 * List the discussion comments on an issue or PR on behalf of ownerDid (#1528).
 *
 * PRs are issues as far as this endpoint is concerned, so one verb covers both
 * conversations. Review comments (inline, on a diff) live on a different
 * endpoint and are deliberately out of scope here.
 *
 * Gates: active `github:read` channel_links row + sealed credential.
 */
export async function listComments(
  ownerDid: string,
  repo: string,
  issueNumber: number,
  options: Readonly<ListCommentsOptions> = {},
): Promise<GitHubListResult<GitHubComment>> {
  const token = await requireGrantAndToken(ownerDid, 'github:read');

  const params = new URLSearchParams();
  if (options.since !== undefined && options.since.length > 0) params.set('since', options.since);
  if (options.direction !== undefined) params.set('direction', options.direction);
  const query = params.toString();

  const limit = normalizeLimit(options.limit);
  const { items, hasMore } = await collectPaginated<GitHubComment>(
    `/repos/${repo}/issues/${issueNumber}/comments${query.length > 0 ? `?${query}` : ''}`,
    token,
    limit,
  );

  return { items, hasMore, limit };
}

// ── Search (#1528 — read-tier, disclosure-allowlist filtered) ───────────────────

/** The `/search/issues` response envelope. */
interface GitHubSearchEnvelope {
  total_count?: number;
  incomplete_results?: boolean;
  items?: GitHubIssue[];
}

export interface GitHubSearchResult extends GitHubListResult<GitHubIssue> {
  /** GitHub's count of ALL matches, independent of `limit`. */
  totalCount: number;
  /** GitHub's own "I timed out mid-search" flag — distinct from `hasMore`. */
  incompleteResults: boolean;
}

export interface SearchIssuesOptions {
  limit?: number;
  sort?: 'comments' | 'created' | 'updated' | 'reactions';
  order?: 'asc' | 'desc';
}

/** Derive `owner/name` from a search item's `repository_url`, or null. */
function repoFullNameFromSearchItem(item: Readonly<GitHubIssue>): string | null {
  const url = item.repository_url;
  if (url === undefined) return null;
  const match = /\/repos\/([^/]+\/[^/?#]+)/.exec(url);
  return match?.[1] ?? null;
}

/**
 * Search issues and PRs with GitHub's query syntax on behalf of ownerDid (#1528).
 *
 * This is the verb for `is:open label:bug`-style questions that no combination
 * of `/issues` filters can express, and the escape hatch when a listing reports
 * `hasMore`.
 *
 * Disclosure: search can reach across every repo the token can see, so results
 * are filtered server-side against the `github:read` allowlist the same way
 * `listRepos` is — a repo the owner chose not to disclose must not leak in via
 * search. Items with an underivable repo are dropped (fail-closed), matching
 * `isRepoAllowed`. Empty/absent allowlist ⇒ allow-all.
 *
 * Gates: active `github:read` channel_links row + sealed credential.
 */
export async function searchIssues(
  ownerDid: string,
  query: string,
  options: Readonly<SearchIssuesOptions> = {},
): Promise<GitHubSearchResult> {
  const token = await requireGrantAndToken(ownerDid, 'github:read');
  const allowlist = await readReadAllowlist(ownerDid);

  const params = new URLSearchParams({ q: query });
  if (options.sort !== undefined) params.set('sort', options.sort);
  if (options.order !== undefined) params.set('order', options.order);

  // total_count/incomplete_results live on the envelope, not the items, so they
  // are captured as the pages stream past rather than re-fetched afterwards.
  let totalCount = 0;
  let incompleteResults = false;

  const limit = normalizeLimit(options.limit);
  const { items, hasMore } = await collectPaginated<GitHubIssue>(
    `/search/issues?${params.toString()}`,
    token,
    limit,
    (item) => {
      const fullName = repoFullNameFromSearchItem(item);
      return fullName !== null && isRepoAllowed(fullName, allowlist);
    },
    (data) => {
      const envelope = (data ?? {}) as GitHubSearchEnvelope;
      totalCount = envelope.total_count ?? totalCount;
      incompleteResults = envelope.incomplete_results ?? incompleteResults;
      return envelope.items ?? [];
    },
  );

  return { items, hasMore, limit, totalCount, incompleteResults };
}

// ── Org / repo discovery (#1373 — read-tier, disclosure-allowlist filtered) ────

export interface GitHubOrg {
  login: string;
  id: number;
  description: string | null;
}

/** GitHub repo permission bits (present when the token can see them). */
export interface GitHubRepoPermissions {
  admin: boolean;
  push: boolean;
  pull: boolean;
  maintain?: boolean;
  triage?: boolean;
}

export interface GitHubRepo {
  full_name: string;
  private: boolean;
  html_url: string;
  description: string | null;
  default_branch: string;
  permissions?: GitHubRepoPermissions;
}

/**
 * List the orgs this connection can see on behalf of ownerDid.
 *
 * Gates: active `github:read` grant + sealed credential (fail-closed, throws).
 * Read-tier — ungated by the confirm/rate rails.
 *
 * Disclosure: results are filtered server-side AFTER the GitHub call against the
 * `github:read` manifest allowlist, so orgs outside the allowlist never cross
 * the wire to the MCP client. Empty/absent allowlist ⇒ allow-all.
 */
export async function listOrgs(ownerDid: string): Promise<GitHubOrg[]> {
  const token = await requireGrantAndToken(ownerDid, 'github:read');

  const { data: orgs } = await callGitHubApi<GitHubOrg[]>({
    method: 'GET',
    path: '/user/orgs?per_page=100',
    token,
  });

  const allowlist = await readReadAllowlist(ownerDid);
  return filterOrgs(orgs, allowlist);
}

/**
 * List the repos this connection can see on behalf of ownerDid.
 *
 * When `org` is provided, lists that org's repos (`/orgs/{org}/repos`);
 * otherwise lists the authenticated user's repos (`/user/repos`).
 *
 * Gates: active `github:read` grant + sealed credential (fail-closed, throws).
 * Read-tier — ungated by the confirm/rate rails.
 *
 * Disclosure: results are filtered server-side AFTER the GitHub call against the
 * `github:read` manifest allowlist. Empty/absent allowlist ⇒ allow-all.
 */
export async function listRepos(ownerDid: string, org?: string): Promise<GitHubRepo[]> {
  const token = await requireGrantAndToken(ownerDid, 'github:read');

  const path =
    org !== undefined && org.length > 0
      ? `/orgs/${encodeURIComponent(org)}/repos?per_page=100`
      : '/user/repos?per_page=100';

  const { data: repos } = await callGitHubApi<GitHubRepo[]>({ method: 'GET', path, token });

  const allowlist = await readReadAllowlist(ownerDid);
  return filterRepos(repos, allowlist);
}

/**
 * Get a single repo's detail on behalf of ownerDid.
 *
 * Gates: active `github:read` grant + sealed credential (fail-closed, throws).
 * Read-tier — ungated by the confirm/rate rails.
 *
 * Disclosure: the target is checked against the `github:read` manifest allowlist
 * BEFORE the fetch. An out-of-allowlist target throws `github_not_in_scope`
 * (no data, no 404-leak) rather than hitting GitHub. Empty/absent ⇒ allow-all.
 */
export async function getRepo(ownerDid: string, repo: string): Promise<GitHubRepo> {
  const token = await requireGrantAndToken(ownerDid, 'github:read');

  const allowlist = await readReadAllowlist(ownerDid);
  if (!isRepoAllowed(repo, allowlist)) {
    throw new Error(
      `github_not_in_scope: repo '${repo}' is outside the github:read disclosure allowlist`,
    );
  }

  const { data } = await callGitHubApi<GitHubRepo>({
    method: 'GET',
    path: `/repos/${repo}`,
    token,
  });
  return data;
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
      message: pendingApprovalMessage(gate.proposalId, gate.reason, gate.limitLabel),
    };
  }

  // Step 3: execute the write.
  const patchBody: Record<string, unknown> = {};
  if (updates.title !== undefined) patchBody.title = updates.title;
  if (updates.body !== undefined) patchBody.body = updates.body;
  if (updates.state !== undefined) patchBody.state = updates.state;

  const { data } = await callGitHubApi<GitHubIssue>({
    method: 'PATCH',
    path: `/repos/${repo}/issues/${issueNumber}`,
    token: gate.token,
    body: patchBody,
  });

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
