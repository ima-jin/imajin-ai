/**
 * Record lane read model (#2289, child of the /jin epic #2288).
 *
 * Today the only read API over the signed event stream
 * (`registry.system_events`) is `GET /api/admin/events` — requireAdmin,
 * no per-principal scoping, no link back to the operator-approval card
 * that authorized a decided event. This module is the per-principal
 * counterpart: any authenticated identity (or an agent acting for one,
 * via `resolveActingDid`) can list the slice of the signed event stream
 * that belongs to them.
 *
 * ## Scoping
 * A principal sees a `system_events` row when:
 *   - they are its issuer (`system_events.did` — the only actor DID the
 *     `emit` bus reactor persists per row today; see
 *     `packages/bus/src/reactors/emit.ts`), OR
 *   - the issuer is an agent that acts for them: either the legacy
 *     coarse `role='agent'` bootstrap (`auth.identity_members`, #1717) or
 *     a scoped #1882 delegation grant they issued
 *     (`auth.delegation_grants.delegatorDid`). Not filtered by
 *     revoked/removed status — an agent that once acted for this
 *     principal keeps its past events on the Record lane even after the
 *     delegation ends, mirroring #1887's "the record doesn't disappear
 *     because the authority did" posture for grants, OR
 *   - the event was authorized by an operator approval this principal
 *     decided: `operator.approvals.operator_did`, joined on
 *     `payload->>'proposalId'` (the only field name the one live
 *     producer — `operator.approval.decided`, see
 *     `operator-approvals-service.ts:307-313` — actually carries; other
 *     approval-authorized payloads such as `vault.key.minted`'s
 *     `authorizedBy.approvalId` are emitted via the `audit-log` reactor
 *     only today, never `emit`, so they never reach `system_events` and
 *     are out of scope for this join key).
 *
 * `subject` (the BusEvent field) is not covered here as a distinct case:
 * the `emit` reactor never persists it (only `event.issuer` becomes
 * `system_events.did` — see the module doc above), and for the one kind
 * that currently reaches this table with an approval ref
 * (`operator.approval.decided`), `subject === issuer === decidedBy`
 * already, so the issuer/decidedBy branches above cover it. Widening
 * `system_events` to store `subject` separately is a real schema change
 * with backfill implications, deliberately out of scope for this issue
 * (see the PR's DECISION block).
 *
 * ## approvalRef / hasOperatorSignature
 * `approvalRef` is populated straight off the joined `operator.approvals`
 * row (`{ proposalId, source, kind }`) when the join matches, else
 * `null`. `hasOperatorSignature` is a boolean presence check on
 * `payload.operatorSignature` (#2082's client-side countersignature) —
 * computed uniformly for every row, `false` when the field is absent, so
 * the Record lane can render the wish-and-grant chain state (#2084)
 * without special-casing which kinds can carry it.
 *
 * #2323: for a decided `decision:card` approval, `approvalRef.chosenOption`
 * is the option letter the operator chose — read straight off the
 * `operator.approval.decided` payload's `mode` (the same field the Inbox
 * posts it in), so the Record lane shows WHAT was chosen without joining
 * back to the card. Absent for every other kind, for the card's own
 * `operator.approval.requested`, and for a decided card with no letter
 * (rejected / withdrawn — "none of these"). Whether the operator's
 * signature actually covers that letter is `modeCountersign` (#2693, below).
 *
 * ## modeCountersign (#2693)
 * Since #2693 the operator's countersignature covers the chosen `mode`
 * (option letter / allow-once / TTL). For a decided event that carries a
 * `mode`, `modeCountersign` says whether that signature actually covers it:
 * `countersigned`, `not-countersigned` (signed before #2693 — the letter is
 * witnessed by the node but not signed by the operator; rendered as
 * "letter not countersigned", NOT as invalid), or `invalid` (the signature
 * verifies against neither shape, e.g. `mode` altered after signing).
 * `not-applicable` for every row with nothing to cover. Pure crypto over the
 * payload's own `keyId` — no extra DB read.
 */
import { and, desc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { db, delegationGrants, identityMembers, operatorApprovals, systemEvents } from '@/src/db';
import { DECISION_APPROVAL_KIND } from '@/src/lib/decisions/view';
import {
  LETTER_NOT_COUNTERSIGNED_LABEL,
  assessDecidedModeCountersignature,
  type ModeCountersignStatus,
} from '@/src/lib/notify/operator-countersign-fields';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export interface RecordEventFilters {
  /** Exact match on `system_events.action` (the bus event type). */
  action?: string;
  /** Lower bound (inclusive) on `system_events.created_at`, ISO 8601. */
  since?: string;
  /** Narrow to one DID already within scope — never widens visibility. */
  agent?: string;
  /** Match `payload->>'grantId'`. */
  grant?: string;
  limit?: number;
  offset?: number;
}

export interface ApprovalRef {
  proposalId: string;
  source: string;
  kind: string;
  /** Option letter chosen on a decided `decision:card` approval (#2323) — read-only projection of the decided payload's `mode`. */
  chosenOption?: string;
}

export interface RecordEventRow {
  id: string;
  service: string;
  action: string;
  did: string | null;
  correlationId: string | null;
  parentEventId: string | null;
  payload: Record<string, unknown> | null;
  status: string | null;
  durationMs: number | null;
  createdAt: string;
  approvalRef: ApprovalRef | null;
  hasOperatorSignature: boolean;
  /** Whether the operator's signature covers this decision's chosen `mode` (#2693). */
  modeCountersign: ModeCountersignStatus;
  /** "letter not countersigned" for a pre-#2693 decision whose `mode` the operator did not sign; null otherwise (#2693). */
  modeCountersignLabel: string | null;
}

export interface RecordEventsPage {
  events: RecordEventRow[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * DIDs of agents that act for `principalDid` — see the module doc's
 * scoping section. Deliberately not filtered by removed/revoked status.
 */
export async function resolveOwnedAgentDids(principalDid: string): Promise<string[]> {
  const [memberRows, grantRows] = await Promise.all([
    db
      .select({ agentDid: identityMembers.memberDid })
      .from(identityMembers)
      .where(and(eq(identityMembers.identityDid, principalDid), eq(identityMembers.role, 'agent'))),
    db
      .select({ agentDid: delegationGrants.agentDid })
      .from(delegationGrants)
      .where(eq(delegationGrants.delegatorDid, principalDid)),
  ]);
  return [
    ...new Set([
      ...memberRows.map((r: { agentDid: string }) => r.agentDid),
      ...grantRows.map((r: { agentDid: string }) => r.agentDid),
    ]),
  ];
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit) || !limit || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.trunc(limit as number));
}

function clampOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset) || !offset || offset < 0) return 0;
  return Math.trunc(offset as number);
}

/** A parseable ISO 8601 `since`, or undefined for anything else (never 500s on a malformed filter). */
function parseSince(since: string | undefined): Date | undefined {
  if (!since) return undefined;
  const parsed = new Date(since);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

type RecordEventQueryRow = {
  id: string;
  service: string;
  action: string;
  did: string | null;
  correlationId: string | null;
  parentEventId: string | null;
  payload: unknown;
  status: string | null;
  durationMs: number | null;
  createdAt: Date;
  approvalProposalId: string | null;
  approvalSource: string | null;
  approvalKind: string | null;
};

/** The chosen option letter, only for an `operator.approval.decided` event on a `decision:card` approval (#2323). */
function chosenOptionOf(row: RecordEventQueryRow, payload: Record<string, unknown> | null): string | undefined {
  if (row.approvalKind !== DECISION_APPROVAL_KIND || row.action !== 'operator.approval.decided') return undefined;
  const mode = payload?.mode;
  return typeof mode === 'string' && mode.length > 0 ? mode : undefined;
}

function toApprovalRef(row: RecordEventQueryRow, payload: Record<string, unknown> | null): ApprovalRef | null {
  if (!row.approvalProposalId) return null;
  const chosenOption = chosenOptionOf(row, payload);
  return {
    proposalId: row.approvalProposalId,
    source: row.approvalSource ?? '',
    kind: row.approvalKind ?? '',
    ...(chosenOption ? { chosenOption } : {}),
  };
}

function toRecordEventRow(row: RecordEventQueryRow): RecordEventRow {
  const payload = (row.payload ?? null) as Record<string, unknown> | null;
  // Only a decided event carries a decision to assess (#2693).
  const modeCountersign: ModeCountersignStatus =
    row.action === 'operator.approval.decided' ? assessDecidedModeCountersignature(payload) : 'not-applicable';
  return {
    id: row.id,
    service: row.service,
    action: row.action,
    did: row.did,
    correlationId: row.correlationId,
    parentEventId: row.parentEventId,
    payload,
    status: row.status,
    durationMs: row.durationMs,
    createdAt: row.createdAt.toISOString(),
    approvalRef: toApprovalRef(row, payload),
    hasOperatorSignature: Boolean(payload?.operatorSignature),
    modeCountersign,
    modeCountersignLabel: modeCountersign === 'not-countersigned' ? LETTER_NOT_COUNTERSIGNED_LABEL : null,
  };
}

/**
 * List the slice of the signed event stream that belongs to `principalDid`,
 * newest first, with the approval-ref join and bounded limit+offset
 * pagination (#2289 acceptance).
 */
export async function listRecordEventsForPrincipal(
  principalDid: string,
  filters: RecordEventFilters = {},
): Promise<RecordEventsPage> {
  const limit = clampLimit(filters.limit);
  const offset = clampOffset(filters.offset);
  const since = parseSince(filters.since);

  const ownedAgentDids = await resolveOwnedAgentDids(principalDid);

  // The one field name the sole live `emit`-reactor producer of an
  // approval-linked event (`operator.approval.decided`) carries — see the
  // module doc for why other `authorizedBy.approvalId` payloads are not
  // joined here.
  const proposalIdJoin = sql`${operatorApprovals.proposalId} = (${systemEvents.payload}->>'proposalId')`;

  const scopeCondition = or(
    eq(systemEvents.did, principalDid),
    inArray(systemEvents.did, ownedAgentDids),
    eq(operatorApprovals.operatorDid, principalDid),
  );

  const agentFilter = filters.agent
    ? or(eq(systemEvents.did, filters.agent), sql`${systemEvents.payload}->>'agentDid' = ${filters.agent}`)
    : undefined;

  const whereClause = and(
    scopeCondition,
    filters.action ? eq(systemEvents.action, filters.action) : undefined,
    since ? gte(systemEvents.createdAt, since) : undefined,
    agentFilter,
    filters.grant ? sql`${systemEvents.payload}->>'grantId' = ${filters.grant}` : undefined,
  );

  const selection = {
    id: systemEvents.id,
    service: systemEvents.service,
    action: systemEvents.action,
    did: systemEvents.did,
    correlationId: systemEvents.correlationId,
    parentEventId: systemEvents.parentEventId,
    payload: systemEvents.payload,
    status: systemEvents.status,
    durationMs: systemEvents.durationMs,
    createdAt: systemEvents.createdAt,
    approvalProposalId: operatorApprovals.proposalId,
    approvalSource: operatorApprovals.source,
    approvalKind: operatorApprovals.kind,
  };

  const [rows, countRows] = await Promise.all([
    db
      .select(selection)
      .from(systemEvents)
      .leftJoin(operatorApprovals, proposalIdJoin)
      .where(whereClause)
      .orderBy(desc(systemEvents.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(systemEvents)
      .leftJoin(operatorApprovals, proposalIdJoin)
      .where(whereClause),
  ]);

  return {
    events: rows.map((row: RecordEventQueryRow) => toRecordEventRow(row)),
    total: countRows[0]?.count ?? 0,
    limit,
    offset,
  };
}
