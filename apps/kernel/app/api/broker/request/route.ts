import { NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { broker } from '@imajin/bus';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

/**
 * POST /api/broker/request — HTTP entry point for bus.broker() (#1048).
 *
 * Thin authenticated wrapper around the in-process broker pipeline.
 * The acting DID must match the declared requester — agents cannot
 * impersonate arbitrary requesters.
 *
 * Body:
 *   type        string    required  — broker event type (e.g. 'profile.field.request')
 *   requester   string    required  — DID of the requesting party (must equal acting DID)
 *   subject     string    required  — DID of the data subject
 *   purpose     string    required  — declared purpose
 *   fields      string[]  required  — requested field names
 *   scope       string    optional  — service scope (defaults to 'default')
 *   data        object    optional  — inline subject data for Phase 1 broker
 *   preview     boolean   optional  — dry-run mode; skips release + audit
 *   mode        string    optional  — 'enforce' (default) | 'shadow'
 *
 * Shadow mode (#1231) runs the full consent + audit pipeline but is
 * non-binding: the response always carries `enforced: false` (on both release
 * and rejection) so the caller logs the decision without acting on it. This is
 * distinct from `preview`, which skips release + audit entirely.
 *
 * Returns BrokerRelease or BrokerRejection, augmented with `mode` and
 * `enforced`.
 */
export async function POST(request: Request) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const actingDid = resolveActingDid(auth.identity);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const type = typeof body.type === 'string' ? body.type.trim() : null;
  const requester = typeof body.requester === 'string' ? body.requester.trim() : null;
  const subject = typeof body.subject === 'string' ? body.subject.trim() : null;
  const purpose = typeof body.purpose === 'string' ? body.purpose.trim() : null;
  const fields = Array.isArray(body.fields) ? (body.fields as unknown[]).filter((f): f is string => typeof f === 'string') : null;
  const scope = typeof body.scope === 'string' ? body.scope : 'default';
  const data = typeof body.data === 'object' && body.data !== null ? (body.data as Record<string, unknown>) : undefined;
  const preview = body.preview === true;
  const mode = body.mode === undefined ? 'enforce' : body.mode;

  if (!type) return NextResponse.json({ error: 'type is required' }, { status: 400 });
  if (!requester) return NextResponse.json({ error: 'requester is required' }, { status: 400 });
  if (!subject) return NextResponse.json({ error: 'subject is required' }, { status: 400 });
  if (!purpose) return NextResponse.json({ error: 'purpose is required' }, { status: 400 });
  if (!fields || fields.length === 0) return NextResponse.json({ error: 'fields must be a non-empty string array' }, { status: 400 });
  if (mode !== 'enforce' && mode !== 'shadow') {
    return NextResponse.json({ error: "mode must be 'enforce' or 'shadow'" }, { status: 400 });
  }

  // Acting DID must match requester — no impersonation.
  if (requester !== actingDid) {
    return NextResponse.json(
      { error: 'requester must equal the authenticated acting DID' },
      { status: 403 },
    );
  }

  log.info({ type, requester, subject, purpose, preview, mode }, 'HTTP broker request');

  const result = await broker(type, {
    type,
    requester,
    subject,
    fields,
    purpose,
    scope,
    data,
    preview,
    mode,
  });

  // Shadow decisions are advisory: always report enforced:false so the caller
  // never gates its flow on the result. The HTTP status stays 200 for both
  // release and rejection (unchanged from enforce mode).
  return NextResponse.json({ ...result, mode, enforced: mode !== 'shadow' });
}
