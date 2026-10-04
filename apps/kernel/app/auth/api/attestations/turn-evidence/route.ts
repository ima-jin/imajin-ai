/**
 * `POST /auth/api/attestations/turn-evidence` — turn-finalization evidence
 * batch (#1978, epic #1758).
 *
 * The agent side (the OpenClaw Imajin plugin's turn hook) signs one
 * `agent.turn.evidence` attestation per tool call locally with the agent's
 * DID key and posts the whole turn's evidence in ONE request — a hook at
 * turn finalization, not a per-call round trip. The signature is the
 * credential (same signed-ingest model as `POST /api/loops`, #2295); there is
 * no session. A forged, unsigned, or unauthorized batch is rejected before
 * anything is written. See `src/lib/turn-evidence/ingest.ts` for the checks
 * and `docs/agents/turn-evidence.md` for the wire contract.
 *
 * Body: `{ evidence: [{ payload, issued_at, signature }, ...] }`, where each
 * item is signed over `turnEvidenceSigningMessage(payload, issued_at)`
 * (`@imajin/auth`).
 *
 * Responses: 201 (≥1 row stored), 200 (every row was an idempotent replay),
 * 400 (malformed / bad signature), 403 (agent may not publish for the
 * principal), 422 (usageRef / outputRef checks), 429, 500.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getClientIP, rateLimit } from '@imajin/config';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { parseTurnEvidenceBatch } from '@/src/lib/turn-evidence/types';
import { ingestTurnEvidence } from '@/src/lib/turn-evidence/ingest';
import { productionIngestDeps } from '@/src/lib/turn-evidence/ingest-deps';
import { INGEST_RATE_LIMIT, INGEST_RATE_WINDOW_MS } from '@/src/lib/turn-evidence/config';

export const dynamic = 'force-dynamic';

const log = createLogger('kernel:turn-evidence');

export function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const limited = rateLimit(`turn-evidence-ingest:${getClientIP(request)}`, INGEST_RATE_LIMIT, INGEST_RATE_WINDOW_MS);
  if (limited.limited) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { ...cors, 'Retry-After': String(limited.retryAfter) } },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const parsed = parseTurnEvidenceBatch(body);
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: cors });
  }

  try {
    const result = await ingestTurnEvidence(parsed.value, productionIngestDeps);
    if (!result.ok) {
      log.warn(
        { agentDid: parsed.value.agentDid, turnEventId: parsed.value.turnEventId, code: result.code },
        'turn evidence batch rejected',
      );
      return NextResponse.json(
        { error: result.error, ...(result.code ? { code: result.code } : {}) },
        { status: result.status, headers: cors },
      );
    }

    log.info(
      { agentDid: parsed.value.agentDid, turnEventId: result.turnEventId, inserted: result.inserted.length },
      'turn evidence ingested',
    );
    return NextResponse.json(
      {
        ok: true,
        turnEventId: result.turnEventId,
        attestations: result.inserted,
        duplicateSeqs: result.duplicateSeqs,
      },
      { status: result.inserted.length > 0 ? 201 : 200, headers: cors },
    );
  } catch (err) {
    log.error({ err: String(err), turnEventId: parsed.value.turnEventId }, 'turn evidence ingest failed');
    return NextResponse.json({ error: 'Failed to store turn evidence' }, { status: 500, headers: cors });
  }
}
