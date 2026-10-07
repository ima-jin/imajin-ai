/**
 * `POST /api/events` — the app-callable surface to emit a domain event onto the
 * kernel bus (#2638 market, #2641 coffee; replaces a standalone app importing the
 * kernel-internal `@imajin/bus`).
 *
 * Ruled (Ryan, 2026-10-07): an app-sent event can only NOTIFY and AUDIT — never
 * move money. Three independent gates, in order:
 *
 *  1. Authentication — a registered app's app-service token
 *     (`Authorization: Bearer <token from POST /auth/api/apps/token/service>`),
 *     i.e. the app proving possession of its registered keypair. Anything else —
 *     missing, malformed, expired, a user-delegated or session token — is 401.
 *  2. Allowlist — `registry.apps.emittable_events`, the list the operator approved
 *     for THIS app (default: empty). An event type not on it is 403, as is an app
 *     that is no longer active.
 *  3. Ceiling — an accepted event goes through `publishAppEvent`, which runs the
 *     notify and audit-log reactors only. Settle, MJN emission and attestation
 *     issuance never run for an app-origin event, whatever the chain config says.
 *
 * The recorded event names the emitting app (its DID) as `issuer` and
 * `payload.originAppDid`, so the operator's audit trail shows which app sent what.
 *
 * Body: { type: string, subject: string, payload?: object, correlationId?: string }
 *   type    — dotted event type, must be on the app's approved list
 *   subject — DID the event is about / the notification recipient
 * `scope` is not accepted: the kernel fixes it, so an app cannot steer which chain
 * row is resolved.
 */
import { NextRequest, NextResponse } from 'next/server';
import { publishAppEvent } from '@imajin/bus';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { verifyAppToken } from '@/src/lib/auth/jwt';
import { APP_NOT_REGISTERED_ERROR } from '@/src/lib/kernel/app-registry';
import { isValidEventType } from '@/src/lib/kernel/emittable-events';
import { resolveEmittableEvents } from '@/src/lib/kernel/app-emittable-events';

export const dynamic = 'force-dynamic';

const log = createLogger('kernel');

const MAX_SUBJECT_LENGTH = 256;
const MAX_CORRELATION_ID_LENGTH = 128;
const MAX_PAYLOAD_BYTES = 16 * 1024;

interface ParsedEmit {
  type: string;
  subject: string;
  payload?: Record<string, unknown>;
  correlationId?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePayload(value: unknown): { ok: Record<string, unknown> | undefined } | { error: string } {
  if (value === undefined) return { ok: undefined };
  if (!isPlainObject(value)) return { error: 'payload must be an object' };
  if (JSON.stringify(value).length > MAX_PAYLOAD_BYTES) {
    return { error: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes` };
  }
  return { ok: value };
}

/** Wire-shape validation only; whether the app may emit `type` is the allowlist's call. */
function parseEmitBody(body: unknown): { ok: ParsedEmit } | { error: string } {
  if (!isPlainObject(body)) return { error: 'Body must be a JSON object' };
  const { type, subject, payload, correlationId } = body;

  if (!isValidEventType(type)) return { error: 'type must be a lowercase dotted event type' };
  if (typeof subject !== 'string' || !subject.startsWith('did:') || subject.length > MAX_SUBJECT_LENGTH) {
    return { error: 'subject must be a DID' };
  }
  if (correlationId !== undefined && (typeof correlationId !== 'string' || correlationId.length > MAX_CORRELATION_ID_LENGTH)) {
    return { error: 'correlationId must be a string' };
  }
  const parsedPayload = parsePayload(payload);
  if ('error' in parsedPayload) return parsedPayload;

  return { ok: { type, subject, payload: parsedPayload.ok, correlationId } };
}

/** The calling app's DID, from a verified app-service token; `null` for anything else. */
async function authenticateApp(request: NextRequest): Promise<string | null> {
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Bearer ')) return null;

  const claims = await verifyAppToken(header.slice(7));
  // Only the keyholder service token proves "this is the app itself". A user-delegated
  // app token (app+jwt) is the app acting for a user, and a session-app token carries
  // no app identity at all — neither may speak as the app on the event bus.
  if (!claims?.isServiceToken || !claims.azp) return null;
  return claims.azp;
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const appDid = await authenticateApp(request);
  if (!appDid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }
  const parsed = parseEmitBody(body);
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400, headers: cors });
  }
  const { type, subject, payload, correlationId } = parsed.ok;

  const approved = await resolveEmittableEvents(appDid);
  if (approved === null) {
    return NextResponse.json(APP_NOT_REGISTERED_ERROR, { status: 403, headers: cors });
  }
  if (!approved.includes(type)) {
    log.warn({ appDid, type }, 'app event refused — type not on the operator-approved list');
    return NextResponse.json(
      { error: 'event_type_not_approved', error_description: `This app is not approved to emit '${type}'.` },
      { status: 403, headers: cors },
    );
  }

  const result = await publishAppEvent(type, { subject, payload, correlationId }, appDid);
  log.info({ appDid, type, ran: result.ran, skipped: result.skipped }, 'app event accepted');

  return NextResponse.json(
    { ok: true, type: result.eventType, origin: result.origin, ran: result.ran },
    { status: 201, headers: cors },
  );
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
