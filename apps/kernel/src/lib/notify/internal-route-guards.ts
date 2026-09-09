/**
 * Shared request guards for the notify app's internal-key-authenticated
 * routes (`.../internal/backlog`, `.../internal/ack`, `.../internal/release`,
 * #2044/#2099) -- `ws-server.js` is plain CJS outside the Next build, so
 * these routes are how it reaches the database. Each route's caller
 * authentication and JSON body parsing were previously hand-rolled and
 * near-identical across all three; extracted here so adding a new internal
 * route does not triplicate that boilerplate.
 */
import { NextRequest, NextResponse } from 'next/server';

/**
 * Fails closed on an unauthenticated caller. An unset
 * `AUTH_INTERNAL_API_KEY` must never degrade into "any caller matches
 * undefined". Returns the 401 response to return immediately, or `null`
 * when the caller is authorized.
 */
export function requireInternalKey(request: NextRequest): NextResponse | null {
  const expectedKey = process.env.AUTH_INTERNAL_API_KEY;
  if (!expectedKey || request.headers.get('x-internal-key') !== expectedKey) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}

export type ParsedJsonBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: NextResponse };

/**
 * Parses the request body as JSON, returning a 400 response for malformed
 * JSON. Normalizes a non-object body (e.g. `null`, an array, a bare string)
 * to `{}` so every route's own field checks can assume an object shape.
 */
export async function parseJsonBody(request: NextRequest): Promise<ParsedJsonBody> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { ok: false, response: NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) };
  }
  const isPlainObject = typeof body === 'object' && body !== null && !Array.isArray(body);
  return { ok: true, body: isPlainObject ? (body as Record<string, unknown>) : {} };
}

export type RequiredStringField =
  | { ok: true; value: string }
  | { ok: false; response: NextResponse };

/** Extracts a required non-empty string field, or the 400 response describing what's missing. */
export function requireStringField(body: Record<string, unknown>, field: string): RequiredStringField {
  const value = body[field];
  if (typeof value !== 'string' || !value) {
    return { ok: false, response: NextResponse.json({ error: `Missing ${field}` }, { status: 400 }) };
  }
  return { ok: true, value };
}
