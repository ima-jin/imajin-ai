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
 * Approval liveness is resolved by scanning the approved rows for the
 * (ownerDid, scope, riskTier) tuple newest-first and retiring any whose window
 * has lapsed — see requireWriteGate() and retireLapsedApprovals() for why a
 * bare `limit(1)` was unsound (#1588).
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

const log = createLogger('kernel');

// Re-exported for backwards compatibility; the value lives in the leaf
// `./constants` module so `./scope-manifest` can read it without importing this
// module (which would re-form the connector → allowlist → scope-manifest cycle).
export { GITHUB_CONNECTOR_DID } from './constants';

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

  const orgs = (await callGitHubApi({
    method: 'GET',
    path: '/user/orgs?per_page=100',
    token,
  })) as GitHubOrg[];

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

  const repos = (await callGitHubApi({ method: 'GET', path, token })) as GitHubRepo[];

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

  return callGitHubApi({
    method: 'GET',
    path: `/repos/${repo}`,
    token,
  }) as Promise<GitHubRepo>;
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
