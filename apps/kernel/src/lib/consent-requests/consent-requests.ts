/**
 * Generic consent-request primitive (#1817).
 *
 * Generalizes the inference confirm gate (`pending_confirm` → Confirm tap IS
 * the signing event, #1782/#1784/#1791) so any app-authed requester holding
 * `consent:write` can ask an approver DID to consent to one described action.
 * Chat proposes (the requester raises the request); the canvas is
 * authoritative + signed (the approver's decision on /jin is the only path
 * to an approve/reject outcome — there is no auto-approval here).
 *
 * Mirrors the node-signing pattern established by inference/consent.ts
 * (#1293) and the GitHub confirm route (#1366, #1429): the kernel signs the
 * decision on the approver's behalf as their explicit tap authorized, using
 * the node's own signing identity (kernel-witnessed).
 */
import { createHash } from 'node:crypto';
import { nanoid } from 'nanoid';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { createLogger } from '@imajin/logger';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import * as bus from '@imajin/bus';
import { db, consentRequests, consentDecisions, type ConsentRequestRow } from '@/src/db';
import { getNodeSigningIdentity } from '@/src/lib/vault/sealing';
import type {
  ConsentDecisionAttestation,
  ConsentDecisionType,
  ConsentRequestCard,
  ConsentRequestRole,
} from './types';

const log = createLogger('kernel:consent-requests');

/** Default and bounds for the caller-supplied TTL. */
export const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const MIN_TTL_MS = 60 * 1000; // 1 minute
export const MAX_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Clamp a caller-supplied TTL into [MIN_TTL_MS, MAX_TTL_MS], defaulting when absent/invalid. */
export function resolveTtlMs(requested: unknown): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(Math.max(requested, MIN_TTL_MS), MAX_TTL_MS);
}

function toCard(row: ConsentRequestRow): ConsentRequestCard {
  return {
    id: row.id,
    requesterDid: row.requesterDid,
    approverDid: row.approverDid,
    kind: row.kind,
    summary: row.summary,
    detail: (row.detail as Record<string, unknown> | null) ?? null,
    status: row.status as ConsentRequestCard['status'],
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    decisionId: row.decisionId ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Resolve a pending request whose TTL has lapsed to 'expired' (#1817:
 * expiry must never be silent). Idempotent and best-effort: the guarded
 * UPDATE only touches rows still 'pending', so a concurrent decision or a
 * repeat call on an already-resolved row is a safe no-op.
 *
 * Called on every read path (list/get) and before a decision is recorded, so
 * an expired request can never be approved/rejected after the fact, and a
 * caller polling the card always sees the true state without a cron sweep.
 */
async function expireIfDue(row: ConsentRequestRow, now: Date): Promise<ConsentRequestRow> {
  if (row.status !== 'pending' || row.expiresAt > now) return row;

  await db
    .update(consentRequests)
    .set({ status: 'expired', resolvedAt: now, updatedAt: now })
    .where(and(eq(consentRequests.id, row.id), eq(consentRequests.status, 'pending')));

  log.info(
    { requestId: row.id, requesterDid: row.requesterDid, approverDid: row.approverDid },
    'consent request expired',
  );

  return { ...row, status: 'expired', resolvedAt: now, updatedAt: now };
}

export interface RaiseConsentRequestParams {
  requesterDid: string;
  approverDid: string;
  kind: string;
  summary: string;
  detail?: Record<string, unknown> | null;
  /** The granted scope that authorized this call — persisted for audit. */
  requesterScope: string;
  ttlMs?: number;
}

/**
 * Raise a consent request: persist it 'pending' and publish `consent.requested`
 * so the notify reactor pushes the confirm card to the approver's /jin (#1644,
 * #1645). The bus publish is best-effort — a failure there must never undo
 * the already-persisted request, since the approver can still discover it via
 * the list endpoint.
 */
export async function raiseConsentRequest(params: RaiseConsentRequestParams): Promise<ConsentRequestCard> {
  const { requesterDid, approverDid, kind, summary, requesterScope } = params;
  const detail = params.detail ?? null;
  const ttlMs = resolveTtlMs(params.ttlMs);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);
  const id = `creq_${nanoid()}`;

  const [row] = await db
    .insert(consentRequests)
    .values({
      id,
      requesterDid,
      approverDid,
      kind,
      summary,
      detail,
      requesterScope,
      status: 'pending',
      expiresAt,
    })
    .returning();

  const card = toCard(row);

  try {
    await bus.publish('consent.requested', {
      issuer: requesterDid,
      subject: approverDid,
      scope: 'consent',
      payload: {
        requestId: id,
        requesterDid,
        approverDid,
        kind,
        summary,
        detail: card.detail,
        expiresAt: card.expiresAt,
        context_id: id,
        context_type: 'consent_request' as const,
      },
    });
  } catch (err) {
    log.error({ err: String(err), requestId: id }, 'consent.requested publish failed (non-fatal)');
  }

  log.info({ requestId: id, requesterDid, approverDid, kind }, 'consent request raised');
  return card;
}

async function loadRequest(requestId: string): Promise<ConsentRequestRow | undefined> {
  const [row] = await db
    .select()
    .from(consentRequests)
    .where(eq(consentRequests.id, requestId))
    .limit(1);
  return row;
}

/** Read a single card, resolving expiry first if it is due. */
export async function getConsentRequestCard(requestId: string): Promise<ConsentRequestCard | undefined> {
  const row = await loadRequest(requestId);
  if (!row) return undefined;
  const fresh = await expireIfDue(row, new Date());
  return toCard(fresh);
}

const VALID_STATUSES = new Set(['pending', 'approved', 'rejected', 'expired']);

/** Statuses returned by default when the caller does not filter explicitly. */
export const DEFAULT_LIST_STATUSES = ['pending', 'approved', 'rejected'] as const;

export function parseStatusFilter(raw: string | null): string[] | null {
  if (!raw) return [...DEFAULT_LIST_STATUSES];
  const statuses = raw.split(',').map((s) => s.trim()).filter((s) => VALID_STATUSES.has(s));
  return statuses.length > 0 ? statuses : null;
}

/** List cards addressed to (role='approver') or raised by (role='requester') a DID. */
export async function listConsentRequestCards(
  did: string,
  role: ConsentRequestRole,
  statuses: readonly string[],
): Promise<ConsentRequestCard[]> {
  const column = role === 'approver' ? consentRequests.approverDid : consentRequests.requesterDid;
  const rows = await db
    .select()
    .from(consentRequests)
    .where(and(eq(column, did), inArray(consentRequests.status, [...statuses])))
    .orderBy(desc(consentRequests.createdAt));

  const now = new Date();
  const fresh = await Promise.all(rows.map((row: ConsentRequestRow) => expireIfDue(row, now)));
  return fresh.map(toCard);
}

export type DecideConsentRequestResult =
  | { ok: true; request: ConsentRequestCard; decision: ConsentDecisionAttestation }
  | { ok: false; error: string; status: number };

export interface DecideConsentRequestParams {
  requestId: string;
  approverDid: string;
  decision: ConsentDecisionType;
}

/**
 * Record the approver's decision: mint a kernel-witnessed `approval.decision`
 * attestation referencing the request, advance the request to
 * approved/rejected, and publish `approval.decision` for the requesting
 * system to consume.
 *
 * Fail-closed: an expired, already-resolved, or ownership-mismatched request
 * is rejected before any signature is produced.
 */
export async function decideConsentRequest(
  params: DecideConsentRequestParams,
): Promise<DecideConsentRequestResult> {
  const { requestId, approverDid, decision } = params;

  const row = await loadRequest(requestId);
  if (!row) {
    return { ok: false, error: 'Consent request not found', status: 404 };
  }
  if (row.approverDid !== approverDid) {
    return { ok: false, error: 'You are not the approver for this consent request', status: 403 };
  }

  const now = new Date();
  const fresh = await expireIfDue(row, now);
  if (fresh.status === 'expired') {
    return { ok: false, error: 'Consent request has expired', status: 409 };
  }
  if (fresh.status !== 'pending') {
    return {
      ok: false,
      error: `Consent request is not awaiting a decision (status: ${fresh.status})`,
      status: 400,
    };
  }

  // ── Sign the kernel-witnessed decision attestation ────────────────────────
  const identity = getNodeSigningIdentity();
  const ts = now.toISOString();
  const summaryDigest = createHash('sha256')
    .update(JSON.stringify({ summary: fresh.summary, detail: fresh.detail ?? null }))
    .digest('hex');
  const payload = {
    requestId,
    requesterDid: fresh.requesterDid,
    approverDid,
    kind: fresh.kind,
    decision,
    summaryDigest,
    ts,
  };
  const signature = authCrypto.signSync(canonicalize(payload), identity.privateKeyHex);
  const decisionId = `cdec_${nanoid()}`;

  await db.insert(consentDecisions).values({
    id: decisionId,
    requestId,
    requesterDid: fresh.requesterDid,
    approverDid,
    decision,
    payload,
    signature,
    senderPubkey: identity.senderPubkey,
  });

  const resolvedStatus = decision === 'approve' ? 'approved' : 'rejected';
  await db
    .update(consentRequests)
    .set({ status: resolvedStatus, resolvedAt: now, decisionId, updatedAt: now })
    .where(and(eq(consentRequests.id, requestId), eq(consentRequests.status, 'pending')));

  const requestCard = toCard({
    ...fresh,
    status: resolvedStatus,
    resolvedAt: now,
    decisionId,
    updatedAt: now,
  });
  const decisionAttestation: ConsentDecisionAttestation = {
    id: decisionId,
    requestId,
    requesterDid: fresh.requesterDid,
    approverDid,
    decision,
    payload,
    signature,
    senderPubkey: identity.senderPubkey,
    signedAt: ts,
  };

  try {
    await bus.publish('approval.decision', {
      issuer: approverDid,
      subject: fresh.requesterDid,
      scope: 'consent',
      payload: {
        requestId,
        requesterDid: fresh.requesterDid,
        approverDid,
        kind: fresh.kind,
        decision,
        attestationId: decisionId,
        decidedAt: ts,
        context_id: requestId,
        context_type: 'consent_request' as const,
      },
    });
  } catch (err) {
    log.error({ err: String(err), requestId }, 'approval.decision publish failed (non-fatal)');
  }

  log.info({ requestId, approverDid, decision, decisionId }, 'consent request decided');
  return { ok: true, request: requestCard, decision: decisionAttestation };
}
