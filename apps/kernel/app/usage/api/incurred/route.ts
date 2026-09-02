/**
 * POST /usage/api/incurred (#1151)
 *
 * The ingest door for every external emitter (Claude Code, Warp, ...)
 * registered in `usage.emitters` — the counterpart to the completions
 * passthrough (`POST /infer/v1/chat/completions`, #1925), which writes
 * `usage.incurred` directly rather than through an HTTP door. Both write
 * into the same stream (#1147): one row per call, one shared ledger.
 *
 * Auth: `requireAppAuth(request, { scope: 'usage:emit' })` (canonical
 * app/agent-auth primitive, docs/guide/canonical-patterns.md). The reference
 * Claude Code adapter authenticates as itself via an app-service token
 * (docs/guide/service-credentials.md) — no delegating human session, since
 * it tails a local log unattended — so the caller DID is
 * `appAuth.userDid || appAuth.appDid`.
 *
 * Per row: the `source` must name an `active` `usage.emitters` row, and the
 * caller DID must be that row's `issuer_did` or its `acting_for` (#1151's
 * "issuer_did (or actingFor chain)" rule). Rows are deduped on
 * `(source, external_id)` via the partial unique index added in
 * migrations/0121_usage_emitters.sql — a re-posted row is silently skipped,
 * not an error.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { requireAppAuth } from '@imajin/auth';
import { rateLimit, getClientIP } from '@imajin/config';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { db, usageIncurred } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { validateIncurredBatch, deriveProviderModel, type ValidatedIncurredRow } from '@/src/lib/usage/incurred-ingest';
import { getEmitter, callerMatchesEmitter, isActiveEmitter } from '@/src/lib/usage/emitters-store';

const log = createLogger('kernel:usage:incurred-ingest');

const INGEST_SCOPE = 'usage:emit';

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const ip = getClientIP(request);
  const rl = rateLimit(ip, 60, 60_000);
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: rl.retryAfter },
      { status: 429, headers: { ...cors, 'Retry-After': String(rl.retryAfter) } },
    );
  }

  const appResult = await requireAppAuth(request, { scope: INGEST_SCOPE });
  if ('error' in appResult) {
    return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
  }
  const callerDid = appResult.appAuth.userDid || appResult.appAuth.appDid;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: cors });
  }

  const validation = validateIncurredBatch(body);
  if ('error' in validation) {
    return NextResponse.json({ error: validation.error }, { status: 400, headers: cors });
  }
  const { accepted, rejected } = validation;

  let inserted = 0;
  let skipped = 0;
  const failures: Array<{ index: number; reason: string }> = rejected;

  // Emitter lookups are cached per source within the batch — a batch is
  // almost always one emitter reporting many rows.
  const emitterCache = new Map<string, Awaited<ReturnType<typeof getEmitter>>>();

  for (const row of accepted) {
    const outcome = await processRow(row, callerDid, emitterCache);
    if (outcome.status === 'inserted') inserted++;
    else if (outcome.status === 'skipped') skipped++;
    else failures.push({ index: row.index, reason: outcome.reason });
  }

  return NextResponse.json({ inserted, skipped, rejected: failures }, { status: 202, headers: cors });
}

type RowOutcome = { status: 'inserted' } | { status: 'skipped' } | { status: 'rejected'; reason: string };

/**
 * Resolve one accepted row's emitter, check the issuer/acting_for match, and
 * insert it. Split out of `POST` purely to keep that function's cognitive
 * complexity readable — the sequence (lookup → gate → insert → catch) is
 * still linear, just named.
 */
async function processRow(
  row: ValidatedIncurredRow,
  callerDid: string,
  emitterCache: Map<string, Awaited<ReturnType<typeof getEmitter>>>,
): Promise<RowOutcome> {
  try {
    if (!emitterCache.has(row.source)) {
      emitterCache.set(row.source, await getEmitter(row.source));
    }
    const emitter = emitterCache.get(row.source);

    if (!isActiveEmitter(emitter)) {
      return { status: 'rejected', reason: `unknown or inactive emitter source: ${row.source}` };
    }
    if (!callerMatchesEmitter(emitter, callerDid)) {
      return { status: 'rejected', reason: "caller is not this emitter's issuer_did or acting_for" };
    }

    const wasInserted = await insertIncurredRow(row, emitter.actingFor, callerDid);
    return { status: wasInserted ? 'inserted' : 'skipped' };
  } catch (err) {
    log.error({ err: String(err), source: row.source, externalId: row.externalId }, 'usage.incurred ingest row failed');
    return { status: 'rejected', reason: 'internal error writing this row' };
  }
}

/**
 * Insert one row, deduped on `(source, external_id)`. Returns true when a
 * new row was written, false when an existing row with the same dedupe key
 * already existed (ON CONFLICT DO NOTHING).
 *
 * `principalDid` (who the spend is attributed to) resolves, in priority
 * order: the row's own `acting_for` (a per-row on-behalf-of override), then
 * the emitter's registered `acting_for`, then the caller itself.
 * `agentDid` mirrors the passthrough's own convention (usage-ledger.ts): the
 * invoking identity, when it differs from who the spend is attributed to.
 */
async function insertIncurredRow(row: ValidatedIncurredRow, emitterActingFor: string | null, callerDid: string): Promise<boolean> {
  const { provider, model } = deriveProviderModel(row);

  const result = await db
    .insert(usageIncurred)
    .values({
      id: generateId('usage'),
      principalDid: row.actingFor ?? emitterActingFor ?? callerDid,
      agentDid: callerDid,
      source: row.source,
      resource: row.resource,
      provider,
      model,
      tokensIn: row.tokensIn ?? null,
      tokensOut: row.tokensOut ?? null,
      costUsd: row.costUsd === undefined ? null : row.costUsd.toFixed(8),
      externalId: row.externalId,
      createdAt: row.ts,
    })
    .onConflictDoNothing({
      target: [usageIncurred.source, usageIncurred.externalId],
      where: sql`${usageIncurred.externalId} IS NOT NULL`,
    })
    .returning({ id: usageIncurred.id });

  // TODO(#1148): publish a usage.incurred bus event per inserted row once
  // #1148's chain/publisher helper lands on main. No publisher exists yet
  // for this event type (packages/bus/src/config.ts) — see #1151's own
  // scope note; do not invent one here.

  return result.length > 0;
}
