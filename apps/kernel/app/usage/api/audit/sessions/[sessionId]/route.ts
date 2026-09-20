/**
 * GET /usage/api/audit/sessions/{sessionId} (#2204 auditor chain view)
 *
 * Prompted by the #1926/#2200 acceptance review ("do we have a way for an
 * auditor to click through and observe this chain?"). Returns everything
 * `usage.incurred` (#1922/#1923/#2202) knows about one OpenClaw session,
 * grouped by turn and ordered oldest-first, with each usage row's linked
 * settlement transaction and signed attestation inlined — so a caller never
 * has to trust that the ledger row and the signed record agree; this
 * endpoint hands back both, read from the same tables `usage-ledger.ts`
 * writes to (see that module's `recordInferenceUsage`/`publishUsageIncurred`
 * for how `session_id`/`turn_id`/`external_id`/`transaction_id` are
 * populated, and `packages/bus/src/types.ts`'s `usage.incurred` event for
 * why the attestation payload carries the same fields).
 *
 * ## Route placement
 * The issue's own text names `GET /audit/sessions/:sessionId` as a
 * possible shape, but every existing kernel service follows the
 * `/{service}/api/...` convention (`api-spec/*.yaml`, `SERVICES` in
 * `@imajin/config`), and the resource here — a session's `usage.incurred`
 * chain — is squarely the `usage` service's own domain. Standing up a new
 * `audit` service would mean a new spec file, a new `/audit/api/spec`
 * route, and a new `SERVICES` entry for a single read endpoint with no
 * other surface — overhead the issue does not ask for. This route is
 * nested under the existing `usage` service instead: `GET
 * /usage/api/audit/sessions/{sessionId}`, registered in `api-spec/usage.yaml`
 * alongside its siblings.
 *
 * ## Scope decision
 * "Owner or auditor grant" access is two distinct mechanisms:
 *   - **Owner**: the caller's own effective DID equals the session's
 *     principal DID (the `usage.incurred` rows' `principal_did`).
 *   - **Auditor**: a DISTINCT DID the owner has delegated to via the #1882
 *     scoped delegation-grant primitive (`packages/auth/src/grant-scopes.ts`,
 *     `introspectGrant`) — the same mechanism external agents already use
 *     for every other cross-DID capability grant in this codebase, and the
 *     one `apps/kernel/app/auth/api/attestations/usage/route.ts` explicitly
 *     flagged as "the natural third path" for reading someone else's usage
 *     when it shipped #1967 without one.
 *
 * The issue asks to "reuse the existing `usage:read`-class scope unless
 * there is a clear reason a new `audit:read` scope is needed". No
 * `usage:read`-shaped scope existed in EITHER scope system before this
 * issue: `infer:usage-read` (`packages/auth/src/scope-vocabulary.ts`) is an
 * OAuth *consent* scope that lets a registered APP act AS its own
 * delegating user (`resolveEffectiveDid`) — it has no way to name a THIRD
 * party DID, so it cannot express "grant this specific auditor read
 * access to MY chain". The #1882 delegation-grant registry
 * (`GRANT_SCOPE_REGISTRY`) is the mechanism built for exactly that shape,
 * and had no `usage:read`-class entry either. This issue adds ONE new
 * entry there, named `usage:read` (not `audit:read`) — the resource being
 * read is `usage.incurred` and what it already links to
 * (`pay.transactions`, `auth.attestations`), so the existing `usage:*`
 * naming class fits; the "chain" framing is a read-model, not a distinct
 * resource that needs its own vocabulary. See `grant-scopes.ts`'s entry
 * for the registry-level rationale.
 */
import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { createLogger } from '@imajin/logger';
import { db, usageIncurred, transactions, attestations } from '@/src/db';
import { introspectGrant } from '@/src/lib/auth/grants';

const log = createLogger('kernel');

/** The #1882 delegation-grant capability an auditor must hold (see the module header for why it is named this, not `audit:read`). */
const AUDIT_READ_CAPABILITY = 'usage:read';

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

interface UsageRowRecord {
  id: string;
  sessionId: string | null;
  turnId: string | null;
  principalDid: string;
  agentDid: string | null;
  source: string;
  resource: string;
  provider: string;
  connectorId: string | null;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: string | null;
  quantity: string | null;
  unit: string | null;
  transactionId: string | null;
  externalId: string | null;
  status: string | null;
  createdAt: Date;
}

interface TransactionRecord {
  id: string;
  amount: string;
  currency: string;
  status: string;
  toDid: string;
  createdAt: Date | null;
}

interface AttestationRecord {
  id: string;
  issuerDid: string;
  /** `usage.incurred.id` this attestation was minted for — see `publishUsageIncurred`'s `context_id: usageId`. */
  contextId: string | null;
  signature: string;
  cid: string | null;
  issuedAt: Date;
  payload: unknown;
}

/** Resolve the calling identity's own DID, or the 401 response to return instead. */
async function resolveCallerDid(request: NextRequest, cors: Record<string, string>): Promise<{ did: string } | { response: NextResponse }> {
  const auth = await requireAuth(request);
  if ('error' in auth) {
    return { response: NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors }) };
  }
  return { did: resolveActingDid(auth.identity) };
}

/** True when `callerDid` is the session's own principal, or holds an active `usage:read` grant from that principal. */
async function isAuthorized(callerDid: string, principalDid: string): Promise<boolean> {
  if (callerDid === principalDid) return true;
  const grant = await introspectGrant({
    agentDid: callerDid,
    capability: AUDIT_READ_CAPABILITY,
    delegatorDid: principalDid,
    targetDid: principalDid,
  });
  return grant.authorized;
}

function serializeTransaction(row: TransactionRecord | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    toDid: row.toDid,
    createdAt: row.createdAt?.toISOString() ?? null,
  };
}

function serializeAttestation(row: AttestationRecord | undefined): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    issuerDid: row.issuerDid,
    // Verbatim, same convention as GET /usage/api/rollup/{did}/latest —
    // this is exactly what the signature covers, never re-derived.
    payload: row.payload ?? {},
    signature: row.signature,
    cid: row.cid,
    issuedAt: row.issuedAt.toISOString(),
  };
}

function serializeUsageRow(
  row: UsageRowRecord,
  txById: Map<string, TransactionRecord>,
  attestationByUsageId: Map<string, AttestationRecord>,
): Record<string, unknown> {
  return {
    id: row.id,
    source: row.source,
    resource: row.resource,
    provider: row.provider,
    connectorId: row.connectorId,
    model: row.model,
    tokensIn: row.tokensIn,
    tokensOut: row.tokensOut,
    costUsd: row.costUsd,
    quantity: row.quantity,
    unit: row.unit,
    status: row.status,
    agentDid: row.agentDid,
    // The upstream request id (x-typesafe-request-id, or the OpenAI/xAI
    // response id) — the last hop in the chain the issue asks for.
    externalId: row.externalId,
    createdAt: row.createdAt.toISOString(),
    transaction: row.transactionId ? serializeTransaction(txById.get(row.transactionId)) : null,
    attestation: serializeAttestation(attestationByUsageId.get(row.id)),
  };
}

/** Group ordered (oldest-first) usage rows into oldest-first turns, preserving each turn's first-seen position. */
function groupByTurn(
  rows: readonly UsageRowRecord[],
  txById: Map<string, TransactionRecord>,
  attestationByUsageId: Map<string, AttestationRecord>,
): Array<{ turnId: string | null; usage: Record<string, unknown>[] }> {
  const turns: Array<{ turnId: string | null; usage: Record<string, unknown>[] }> = [];
  const byTurnId = new Map<string | null, Record<string, unknown>[]>();

  for (const row of rows) {
    let usageList = byTurnId.get(row.turnId);
    if (!usageList) {
      usageList = [];
      byTurnId.set(row.turnId, usageList);
      turns.push({ turnId: row.turnId, usage: usageList });
    }
    usageList.push(serializeUsageRow(row, txById, attestationByUsageId));
  }

  return turns;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ sessionId: string }> }) {
  const cors = corsHeaders(request);
  const { sessionId: rawSessionId } = await params;
  const sessionId = decodeURIComponent(rawSessionId).trim();
  if (sessionId.length === 0) {
    return NextResponse.json({ error: 'sessionId is required' }, { status: 400, headers: cors });
  }

  const caller = await resolveCallerDid(request, cors);
  if ('response' in caller) return caller.response;

  try {
    const rows = (await db
      .select()
      .from(usageIncurred)
      .where(eq(usageIncurred.sessionId, sessionId))
      .orderBy(asc(usageIncurred.createdAt))) as UsageRowRecord[];

    if (rows.length === 0) {
      return NextResponse.json({ error: 'No usage.incurred rows found for this session' }, { status: 404, headers: cors });
    }

    const principalDid = rows[0].principalDid;
    if (!(await isAuthorized(caller.did, principalDid))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: cors });
    }

    const transactionIds = [...new Set(rows.map((row) => row.transactionId).filter((id): id is string => Boolean(id)))];
    const txRows = transactionIds.length > 0
      ? ((await db.select().from(transactions).where(inArray(transactions.id, transactionIds))) as TransactionRecord[])
      : [];
    const txById = new Map(txRows.map((row) => [row.id, row]));

    const usageIds = rows.map((row) => row.id);
    const attestationRows = (await db
      .select()
      .from(attestations)
      .where(and(eq(attestations.type, 'usage.incurred'), eq(attestations.contextType, 'usage'), inArray(attestations.contextId, usageIds)))) as AttestationRecord[];
    const attestationByUsageId = new Map<string, AttestationRecord>();
    for (const row of attestationRows) {
      if (row.contextId) attestationByUsageId.set(row.contextId, row);
    }

    return NextResponse.json(
      {
        sessionId,
        principalDid,
        turns: groupByTurn(rows, txById, attestationByUsageId),
      },
      { headers: { ...cors, 'Cache-Control': 'no-store' } },
    );
  } catch (err) {
    log.error({ err: String(err), sessionId }, 'audit chain-view query failed');
    return NextResponse.json({ error: 'Failed to load session chain' }, { status: 500, headers: cors });
  }
}
