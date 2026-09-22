/**
 * Delegate-grant bearer credential (#2252) — the outbound shape for
 * static-header foreign clients (Meta Muse consumer connector / Muse Code)
 * that cannot complete our OAuth+PKCE dance. Ryan's 2026-09-22 ruling:
 * never a PAT (#1340 NOT-PAT rule) — a delegation-grant credential, bound to
 * purpose + client, minted only after an operator-countersigned decision,
 * sliding expiry with a hard 90-day cap, revocable, every use attested.
 *
 * ## Lifecycle
 *   KNOCK    — {@link createDelegateGrantKnock}. A pending request bound to
 *              {principalDid, clientLabel, purpose, scopes, surfaces}.
 *              Pends 24h then expires if never decided.
 *   APPROVE  — {@link issueDelegateGrantBearer}, called from
 *              `../access/approvals-execution.ts` right after the operator's
 *              countersigned decision is recorded (the canvas-is-the-
 *              signing-event pattern, #2247). Mints a random high-entropy
 *              bearer, stores ONLY its hash, returns the plaintext exactly
 *              once.
 *   USE      — {@link resolveDelegateGrantBearer}. Called from the MCP
 *              route's auth gate. A single atomic UPDATE both authenticates
 *              and slides the expiry window forward — no separate read/write
 *              race, and no in-memory cache (so revocation is immediate,
 *              well under the 60s bound the issue calls for).
 *   REVOKE   — {@link revokeDelegateGrantBearer}. A tombstone: the row
 *              survives (audit trail) but `tokenHash` is erased to NULL, so
 *              a lookup by the old plaintext can never resolve again.
 *
 * ## Surfaces (v1 scope decision)
 * Only `'mcp'` is enforced end-to-end in this slice — the MCP route's
 * existing scope-checked auth gate (`app/mcp/route.ts`) is the one place a
 * bearer's granted scopes are threaded through to per-tool authorization
 * with no further plumbing. `requireAuth()`'s generic REST auth choke point
 * (`app/auth/api/validate/route.ts`) has no per-route notion of "which
 * surface is this" or "which scope does this route require", so wiring a
 * second surface (e.g. `media`) there today would mean the bearer grants
 * FULL session-equivalent access to every `requireAuth()`-gated route, not
 * "the granted scopes, nothing wider" — a real widening of the credential's
 * blast radius the issue explicitly rules out. Threading a required-scope
 * parameter through `requireAuth()` is real follow-up work, flagged in the
 * PR description rather than half-built here. `surfaces` is still stored
 * generically (schema + validation) so that follow-up is additive.
 */
import { eq, and, gt, desc, sql } from 'drizzle-orm';
import { emitAttestation } from '@imajin/auth';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { db, delegateGrantRequests, delegateGrantBearers, type DelegateGrantRequestRow, type DelegateGrantBearerRow } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { generateOpaqueToken, hashToken, MCP_SCOPE_SET } from '@/src/lib/mcp/oauth-config';
import type { VaultAuthorization } from '../vault/authorization';

const log = createLogger('kernel:access');

/** The only selectable sliding-inactivity windows (Ryan's 2026-09-22 ruling). */
export const DELEGATE_GRANT_SLIDING_WINDOW_DAYS_OPTIONS = [30, 90, 180, 365] as const;
export type DelegateGrantSlidingWindowDays = (typeof DELEGATE_GRANT_SLIDING_WINDOW_DAYS_OPTIONS)[number];
export const DELEGATE_GRANT_DEFAULT_SLIDING_WINDOW_DAYS: DelegateGrantSlidingWindowDays = 90;

/** Fixed, unconditional lifetime ceiling — dead after this instant regardless of use. */
export const DELEGATE_GRANT_HARD_CAP_DAYS = 90;

/** How long a knock pends before it can no longer be decided. */
export const DELEGATE_GRANT_KNOCK_PENDING_HOURS = 24;

/**
 * Surfaces the knock/approve flow will validate and store. Only `'mcp'` is
 * actually enforceable end-to-end today — see the module docblock's "v1
 * scope decision" note. Kept as a Set (not just `['mcp']`) so a future
 * surface is a one-line addition here plus the corresponding enforcement
 * wiring, not a schema change.
 */
export const DELEGATE_GRANT_SUPPORTED_SURFACES: readonly string[] = ['mcp'];

const MAX_CLIENT_LABEL_LENGTH = 200;
const MAX_PURPOSE_LENGTH = 500;
const MAX_SCOPES = 32;
const MAX_SURFACES = 8;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function isSlidingWindowDays(value: unknown): value is DelegateGrantSlidingWindowDays {
  return typeof value === 'number' && (DELEGATE_GRANT_SLIDING_WINDOW_DAYS_OPTIONS as readonly number[]).includes(value);
}

export interface CreateDelegateGrantKnockParams {
  principalDid: string;
  clientLabel: string;
  purpose: string;
  scopes: string[];
  surfaces: string[];
  slidingWindowDays?: number;
}

export type CreateDelegateGrantKnockResult =
  | { ok: true; requestId: string; expiresAt: string; slidingWindowDays: DelegateGrantSlidingWindowDays }
  | { ok: false; error: string };

/**
 * Shape-validate a knock request. Pure and synchronous so the route layer
 * can 400 before touching the database — mirrors the validate-then-insert
 * split every other proposal-raising route in this codebase already uses
 * (e.g. `app/jin/api/vault-proposals/route.ts`).
 */
export function validateDelegateGrantKnockInput(params: CreateDelegateGrantKnockParams): { ok: true } | { ok: false; error: string } {
  const { clientLabel, purpose, scopes, surfaces, slidingWindowDays } = params;

  if (typeof clientLabel !== 'string' || clientLabel.trim().length === 0 || clientLabel.length > MAX_CLIENT_LABEL_LENGTH) {
    return { ok: false, error: `clientLabel is required (max ${MAX_CLIENT_LABEL_LENGTH} chars)` };
  }
  if (typeof purpose !== 'string' || purpose.trim().length === 0 || purpose.length > MAX_PURPOSE_LENGTH) {
    return { ok: false, error: `purpose is required (max ${MAX_PURPOSE_LENGTH} chars)` };
  }
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > MAX_SCOPES) {
    return { ok: false, error: `scopes must be a non-empty array of at most ${MAX_SCOPES} scope strings` };
  }
  if (!scopes.every((s) => typeof s === 'string' && MCP_SCOPE_SET.has(s))) {
    return { ok: false, error: 'every scope must be a recognized, MCP-carryable scope string' };
  }
  if (!Array.isArray(surfaces) || surfaces.length === 0 || surfaces.length > MAX_SURFACES) {
    return { ok: false, error: `surfaces must be a non-empty array of at most ${MAX_SURFACES} surface names` };
  }
  if (!surfaces.every((s) => typeof s === 'string' && DELEGATE_GRANT_SUPPORTED_SURFACES.includes(s))) {
    return { ok: false, error: `every surface must be one of: ${DELEGATE_GRANT_SUPPORTED_SURFACES.join(', ')}` };
  }
  if (slidingWindowDays !== undefined && !isSlidingWindowDays(slidingWindowDays)) {
    return { ok: false, error: `slidingWindowDays must be one of: ${DELEGATE_GRANT_SLIDING_WINDOW_DAYS_OPTIONS.join(', ')}` };
  }
  return { ok: true };
}

/**
 * Create the pending KNOCK record and attest `access.knock`. Never raises
 * the operator-approvals card itself — that's the route layer's job (it
 * also needs to compute the generic `operator_approvals` contentHash),
 * mirroring how `vault-proposals/route.ts` composes validation +
 * `recordApprovalRequested` at the route, not the domain-module, layer.
 */
export async function createDelegateGrantKnock(params: CreateDelegateGrantKnockParams): Promise<CreateDelegateGrantKnockResult> {
  const validation = validateDelegateGrantKnockInput(params);
  if (!validation.ok) return validation;

  const { principalDid, clientLabel, purpose, scopes, surfaces } = params;
  const slidingWindowDays = isSlidingWindowDays(params.slidingWindowDays)
    ? params.slidingWindowDays
    : DELEGATE_GRANT_DEFAULT_SLIDING_WINDOW_DAYS;
  const requestId = generateId('dgr');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DELEGATE_GRANT_KNOCK_PENDING_HOURS * 60 * 60 * 1000);

  await db.insert(delegateGrantRequests).values({
    id: requestId,
    principalDid,
    clientLabel,
    purpose,
    scopes,
    surfaces,
    slidingWindowDays,
    status: 'pending',
    expiresAt,
  });

  const nodeDid = await getNodeDid();
  emitAttestation({
    issuer_did: nodeDid,
    subject_did: principalDid,
    type: 'access.knock',
    context_id: requestId,
    context_type: 'access.knock',
    payload: { requestId, clientLabel, purpose, scopes, surfaces, slidingWindowDays },
  }).catch((err: unknown) => log.error({ err: String(err), requestId }, 'access.knock attestation failed'));

  publish('access.knock.requested', {
    issuer: nodeDid,
    subject: principalDid,
    scope: 'access',
    payload: { requestId, principalDid, clientLabel, purpose, scopes, surfaces, context_id: requestId, context_type: 'access.knock' },
  }).catch((err: unknown) => log.error({ err: String(err), requestId }, 'access.knock.requested publish failed'));

  return { ok: true, requestId, expiresAt: expiresAt.toISOString(), slidingWindowDays };
}

export async function getDelegateGrantRequestById(requestId: string): Promise<DelegateGrantRequestRow | undefined> {
  const [row] = await db.select().from(delegateGrantRequests).where(eq(delegateGrantRequests.id, requestId)).limit(1);
  return row;
}

/** Mark a knock request expired — idempotent, only transitions from 'pending'. */
export async function markDelegateGrantRequestExpired(requestId: string): Promise<void> {
  await db
    .update(delegateGrantRequests)
    .set({ status: 'expired' })
    .where(and(eq(delegateGrantRequests.id, requestId), eq(delegateGrantRequests.status, 'pending')));
}

export interface IssueDelegateGrantBearerParams {
  request: DelegateGrantRequestRow;
  /** Always the NODE identity (mirrors #2247's signing-roles ruling — the node executes and witnesses, never the operator). */
  issuedBy: string;
  authorizedBy: VaultAuthorization;
}

export interface IssueDelegateGrantBearerResult {
  /** The plaintext bearer — the ONLY time it is ever available. Never logged, never stored. */
  bearer: string;
  bearerId: string;
  expiresAt: string;
  hardCapAt: string;
}

/**
 * Mint the bearer for an approved knock: random 256-bit opaque secret
 * (`generateOpaqueToken`, the same primitive OAuth authorization codes /
 * refresh tokens already use), stores only its sha256 hash, marks the
 * request 'approved', and attests `access.bearer.issued` with the
 * `authorizedBy` audit-trail reference (mirrors `vault.key.minted`'s shape,
 * #2247). Never throws on the attestation/publish side — those are
 * fire-and-forget, matching every other mechanical-attestation emitter in
 * this codebase; a DB failure on the insert/update itself DOES propagate,
 * since a bearer nobody can retrieve later must not silently "succeed".
 */
export async function issueDelegateGrantBearer(params: IssueDelegateGrantBearerParams): Promise<IssueDelegateGrantBearerResult> {
  const { request, issuedBy, authorizedBy } = params;
  const bearer = generateOpaqueToken();
  const tokenHash = hashToken(bearer);
  const bearerId = generateId('dgb');
  const now = new Date();
  const slidingWindowDays = isSlidingWindowDays(request.slidingWindowDays)
    ? request.slidingWindowDays
    : DELEGATE_GRANT_DEFAULT_SLIDING_WINDOW_DAYS;
  const hardCapAt = new Date(now.getTime() + DELEGATE_GRANT_HARD_CAP_DAYS * ONE_DAY_MS);
  const slidingExpiresAt = new Date(now.getTime() + slidingWindowDays * ONE_DAY_MS);
  const expiresAt = slidingExpiresAt.getTime() < hardCapAt.getTime() ? slidingExpiresAt : hardCapAt;

  await db.insert(delegateGrantBearers).values({
    id: bearerId,
    requestId: request.id,
    principalDid: request.principalDid,
    clientLabel: request.clientLabel,
    purpose: request.purpose,
    scopes: request.scopes,
    surfaces: request.surfaces,
    tokenHash,
    slidingWindowDays,
    issuedAt: now,
    expiresAt,
    hardCapAt,
    status: 'active',
    approvalId: authorizedBy.approvalId,
  });

  await db
    .update(delegateGrantRequests)
    .set({ status: 'approved', decidedAt: now })
    .where(eq(delegateGrantRequests.id, request.id));

  emitAttestation({
    issuer_did: issuedBy,
    subject_did: request.principalDid,
    type: 'access.bearer.issued',
    context_id: bearerId,
    context_type: 'access.bearer',
    payload: {
      bearerId,
      requestId: request.id,
      clientLabel: request.clientLabel,
      purpose: request.purpose,
      scopes: request.scopes,
      surfaces: request.surfaces,
      slidingWindowDays,
      expiresAt: expiresAt.toISOString(),
      hardCapAt: hardCapAt.toISOString(),
      authorizedBy,
    },
  }).catch((err: unknown) => log.error({ err: String(err), bearerId }, 'access.bearer.issued attestation failed'));

  publish('access.bearer.issued', {
    issuer: issuedBy,
    subject: request.principalDid,
    scope: 'access',
    payload: {
      bearerId,
      requestId: request.id,
      principalDid: request.principalDid,
      clientLabel: request.clientLabel,
      purpose: request.purpose,
      scopes: request.scopes,
      surfaces: request.surfaces,
      expiresAt: expiresAt.toISOString(),
      hardCapAt: hardCapAt.toISOString(),
      authorizedBy,
      context_id: bearerId,
      context_type: 'access.bearer',
    },
  }).catch((err: unknown) => log.error({ err: String(err), bearerId }, 'Bus publish error for access.bearer.issued'));

  return { bearer, bearerId, expiresAt: expiresAt.toISOString(), hardCapAt: hardCapAt.toISOString() };
}

export type ResolveDelegateGrantBearerDenialReason = 'unknown' | 'expired' | 'surface_miss';

export type ResolveDelegateGrantBearerResult =
  | { ok: true; principalDid: string; scopes: string[]; bearerId: string }
  | { ok: false; reason: ResolveDelegateGrantBearerDenialReason };

/** Emit `access.bearer.used` — one per successful authentication, never batched. */
async function emitBearerUsed(row: DelegateGrantBearerRow, surface: string): Promise<void> {
  const nodeDid = await getNodeDid();
  emitAttestation({
    issuer_did: nodeDid,
    subject_did: row.principalDid,
    type: 'access.bearer.used',
    context_id: row.id,
    context_type: 'access.bearer',
    payload: { bearerId: row.id, surface },
  }).catch((err: unknown) => log.error({ err: String(err), bearerId: row.id }, 'access.bearer.used attestation failed'));

  publish('access.bearer.used', {
    issuer: nodeDid,
    subject: row.principalDid,
    scope: 'access',
    payload: { bearerId: row.id, principalDid: row.principalDid, surface, context_id: row.id, context_type: 'access.bearer' },
  }).catch((err: unknown) => log.error({ err: String(err), bearerId: row.id }, 'Bus publish error for access.bearer.used'));
}

/**
 * Emit `access.bearer.denied` for a RESOLVABLE bearer that failed a check
 * (expired past its window/hard cap, or presented against a surface it was
 * never granted). Deliberately NOT called for a wholly unknown token — see
 * {@link resolveDelegateGrantBearer}'s docs on why that path mints no
 * attestation at all.
 */
async function emitBearerDenied(row: DelegateGrantBearerRow, surface: string, reason: 'expired' | 'surface_miss'): Promise<void> {
  const nodeDid = await getNodeDid();
  emitAttestation({
    issuer_did: nodeDid,
    subject_did: row.principalDid,
    type: 'access.bearer.denied',
    context_id: row.id,
    context_type: 'access.bearer',
    payload: { bearerId: row.id, surface, reason },
  }).catch((err: unknown) => log.error({ err: String(err), bearerId: row.id }, 'access.bearer.denied attestation failed'));

  publish('access.bearer.denied', {
    issuer: nodeDid,
    subject: row.principalDid,
    scope: 'access',
    payload: { bearerId: row.id, principalDid: row.principalDid, surface, reason, context_id: row.id, context_type: 'access.bearer' },
  }).catch((err: unknown) => log.error({ err: String(err), bearerId: row.id }, 'Bus publish error for access.bearer.denied'));
}

/**
 * Authenticate a presented bearer for `surface` and, on success, atomically
 * slide its expiry forward. One statement does both the read and the
 * extension (`UPDATE ... WHERE token_hash = ? AND status = 'active' AND
 * expires_at > now() AND hard_cap_at > now() AND surfaces @> [surface]
 * RETURNING *`) — there is no read-then-write race, and no cache to bound:
 * revocation and expiry are both visible to the very next call.
 *
 * Denial reasons are deliberately NOT uniformly distinguishable to the
 * caller by design:
 *   - 'unknown' covers a token that never existed AND a revoked-and-
 *     tombstoned one (the schema erases `tokenHash` on revoke — see
 *     `revokeDelegateGrantBearer` — so a lookup by the old plaintext
 *     structurally cannot tell "never existed" from "revoked" apart; that
 *     erasure IS the security property, not a gap in this function).
 *   - 'expired' and 'surface_miss' are only reachable when the row is still
 *     resolvable by its (still-live) tokenHash, so those DO get an
 *     `access.bearer.denied` attestation; 'unknown' does not (see
 *     {@link emitBearerDenied}'s docs — attesting arbitrary presented
 *     garbage would be an unbounded attestation-flood vector).
 */
export async function resolveDelegateGrantBearer(token: string, surface: string): Promise<ResolveDelegateGrantBearerResult> {
  const tokenHash = hashToken(token);

  const [used] = await db
    .update(delegateGrantBearers)
    .set({
      lastUsedAt: sql`now()`,
      expiresAt: sql`LEAST(now() + (${delegateGrantBearers.slidingWindowDays} || ' days')::interval, ${delegateGrantBearers.hardCapAt})`,
    })
    .where(and(
      eq(delegateGrantBearers.tokenHash, tokenHash),
      eq(delegateGrantBearers.status, 'active'),
      gt(delegateGrantBearers.expiresAt, sql`now()`),
      gt(delegateGrantBearers.hardCapAt, sql`now()`),
      sql`${delegateGrantBearers.surfaces} @> ${JSON.stringify([surface])}::jsonb`,
    ))
    .returning();

  if (used) {
    await emitBearerUsed(used, surface);
    return { ok: true, principalDid: used.principalDid, scopes: (used.scopes as string[] | null) ?? [], bearerId: used.id };
  }

  const [existing] = await db.select().from(delegateGrantBearers).where(eq(delegateGrantBearers.tokenHash, tokenHash)).limit(1);
  if (!existing) {
    return { ok: false, reason: 'unknown' };
  }

  const surfaces = (existing.surfaces as string[] | null) ?? [];
  const reason: 'expired' | 'surface_miss' = surfaces.includes(surface) ? 'expired' : 'surface_miss';
  await emitBearerDenied(existing, surface, reason);
  return { ok: false, reason };
}

export type RevokeDelegateGrantBearerResult = 'revoked' | 'already_revoked' | 'not_found' | 'forbidden';

/**
 * Tombstone a bearer: the row survives (so the record remembers a
 * credential existed), `tokenHash` is erased to NULL (so it can never
 * resolve again — see {@link resolveDelegateGrantBearer}'s docs). Only the
 * owning principal may revoke their own bearer. Immediate effect: there is
 * no cache anywhere in the resolve path, so the very next call using the
 * old plaintext denies with 'unknown'.
 */
export async function revokeDelegateGrantBearer(params: {
  bearerId: string;
  requestedByDid: string;
}): Promise<RevokeDelegateGrantBearerResult> {
  const [row] = await db.select().from(delegateGrantBearers).where(eq(delegateGrantBearers.id, params.bearerId)).limit(1);
  if (!row) return 'not_found';
  if (row.principalDid !== params.requestedByDid) return 'forbidden';
  if (row.status === 'revoked') return 'already_revoked';

  await db
    .update(delegateGrantBearers)
    .set({ status: 'revoked', tokenHash: null, revokedAt: new Date(), revokedBy: params.requestedByDid })
    .where(eq(delegateGrantBearers.id, params.bearerId));

  const nodeDid = await getNodeDid();
  emitAttestation({
    issuer_did: nodeDid,
    subject_did: row.principalDid,
    type: 'access.bearer.revoked',
    context_id: row.id,
    context_type: 'access.bearer',
    payload: { bearerId: row.id, clientLabel: row.clientLabel, revokedBy: params.requestedByDid },
  }).catch((err: unknown) => log.error({ err: String(err), bearerId: row.id }, 'access.bearer.revoked attestation failed'));

  publish('access.bearer.revoked', {
    issuer: nodeDid,
    subject: row.principalDid,
    scope: 'access',
    payload: {
      bearerId: row.id,
      principalDid: row.principalDid,
      clientLabel: row.clientLabel,
      revokedBy: params.requestedByDid,
      context_id: row.id,
      context_type: 'access.bearer',
    },
  }).catch((err: unknown) => log.error({ err: String(err), bearerId: row.id }, 'Bus publish error for access.bearer.revoked'));

  return 'revoked';
}

export interface DelegateGrantBearerSummary {
  bearerId: string;
  clientLabel: string;
  purpose: string;
  scopes: string[];
  surfaces: string[];
  status: string;
  issuedAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  hardCapAt: string;
}

/** List a principal's own bearers — metadata only, never `tokenHash`. */
export async function listDelegateGrantBearersForPrincipal(principalDid: string): Promise<DelegateGrantBearerSummary[]> {
  const rows = await db
    .select()
    .from(delegateGrantBearers)
    .where(eq(delegateGrantBearers.principalDid, principalDid))
    .orderBy(desc(delegateGrantBearers.issuedAt));

  return rows.map((row) => ({
    bearerId: row.id,
    clientLabel: row.clientLabel,
    purpose: row.purpose,
    scopes: (row.scopes as string[] | null) ?? [],
    surfaces: (row.surfaces as string[] | null) ?? [],
    status: row.status,
    issuedAt: row.issuedAt.toISOString(),
    lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    expiresAt: row.expiresAt.toISOString(),
    hardCapAt: row.hardCapAt.toISOString(),
  }));
}
