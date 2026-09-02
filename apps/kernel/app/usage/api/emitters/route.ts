/**
 * GET/PUT /usage/api/emitters (#1151)
 *
 * The `usage.emitters` registry itself — where a DID names the emitters it
 * will later push rows through via `POST /usage/api/incurred`.
 *
 * Owner-only by construction: `resolveEffectiveDid` (canonical session/app
 * dual-path auth, `@imajin/auth`) resolves the caller's own effective DID,
 * and every read/write is scoped to rows whose `issuer_did` equals it. `GET`
 * lists the caller's own registrations; `PUT` registers or updates one,
 * forcing `issuerDid` to the caller's own DID so a caller can never register
 * a row claiming to be issued by someone else.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { resolveEffectiveDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders, corsOptions } from '@/src/lib/kernel/cors';
import { listEmittersForIssuer, upsertEmitter } from '@/src/lib/usage/emitters-store';

const log = createLogger('kernel:usage:emitters');

const EMITTERS_SCOPE = 'usage:emitters-manage';

export const dynamic = 'force-dynamic';

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

function responseHeaders(request: NextRequest): Record<string, string> {
  return {
    ...corsHeaders(request),
    'Cache-Control': 'no-store',
  };
}

export async function GET(request: NextRequest) {
  const headers = responseHeaders(request);

  const auth = await resolveEffectiveDid(request, { scope: EMITTERS_SCOPE });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  }

  try {
    const emitters = await listEmittersForIssuer(auth.effectiveDid);
    return NextResponse.json({ emitters }, { headers });
  } catch (err) {
    log.error({ err: String(err), issuerDid: auth.effectiveDid }, 'usage.emitters list failed');
    return NextResponse.json({ error: 'Emitter registry unavailable' }, { status: 500, headers });
  }
}

interface PutBody {
  source?: unknown;
  reader?: unknown;
  actingFor?: unknown;
  keyField?: unknown;
  cadence?: unknown;
  config?: unknown;
  status?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export async function PUT(request: NextRequest) {
  const headers = responseHeaders(request);

  const auth = await resolveEffectiveDid(request, { scope: EMITTERS_SCOPE });
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status, headers });
  }

  let body: PutBody;
  try {
    body = (await request.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers });
  }

  if (!isNonEmptyString(body.source)) {
    return NextResponse.json({ error: 'source must be a non-empty string' }, { status: 400, headers });
  }
  if (!isNonEmptyString(body.reader)) {
    return NextResponse.json({ error: 'reader must be a non-empty string' }, { status: 400, headers });
  }
  if (body.status !== undefined && body.status !== 'active' && body.status !== 'revoked') {
    return NextResponse.json({ error: "status must be 'active' or 'revoked' when present" }, { status: 400, headers });
  }
  if (body.actingFor !== undefined && !isNonEmptyString(body.actingFor)) {
    return NextResponse.json({ error: 'actingFor must be a string when present' }, { status: 400, headers });
  }
  if (body.keyField !== undefined && !isNonEmptyString(body.keyField)) {
    return NextResponse.json({ error: 'keyField must be a string when present' }, { status: 400, headers });
  }
  if (body.cadence !== undefined && !isNonEmptyString(body.cadence)) {
    return NextResponse.json({ error: 'cadence must be a string when present' }, { status: 400, headers });
  }
  if (body.config !== undefined && (typeof body.config !== 'object' || body.config === null || Array.isArray(body.config))) {
    return NextResponse.json({ error: 'config must be an object when present' }, { status: 400, headers });
  }

  try {
    const emitter = await upsertEmitter({
      source: body.source,
      reader: body.reader,
      // Forced to the caller's own effective DID — a caller cannot register
      // an emitter claiming to be issued by someone else.
      issuerDid: auth.effectiveDid,
      actingFor: body.actingFor as string | undefined,
      keyField: body.keyField as string | undefined,
      cadence: body.cadence as string | undefined,
      config: body.config as Record<string, unknown> | undefined,
      status: body.status as 'active' | 'revoked' | undefined,
    });
    return NextResponse.json({ emitter }, { headers });
  } catch (err) {
    log.error({ err: String(err), issuerDid: auth.effectiveDid, source: body.source }, 'usage.emitters upsert failed');
    return NextResponse.json({ error: 'Emitter registration failed' }, { status: 500, headers });
  }
}
