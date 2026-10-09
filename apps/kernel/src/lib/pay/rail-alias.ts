/**
 * Rail-generic route aliases (#2177 item 3, parent #2173).
 *
 * `api-spec/pay.yaml` documents rail-generic operations — `/api/webhook/{provider}`
 * — alongside the original Stripe-named operations. The original routes are
 * untouched (no client breakage); the rail-generic routes are thin aliases that
 * dispatch on the `{provider}` path segment to the SAME handler the Stripe-named
 * route runs. Adding a rail is one entry in the handler map a route passes to
 * {@link railAliasRoute}.
 *
 * This module never imports a rail SDK (the `ci-guard-stripe-import-scope`
 * guard keeps that under `providers/`).
 */
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@/src/lib/kernel/cors';

/** A rail-specific route handler — what a Stripe-named route already exports. */
export type RailRouteHandler = (request: NextRequest) => Promise<Response>;

/** Handlers keyed by `{provider}` path-segment value. */
export type RailHandlers = Readonly<Record<string, RailRouteHandler>>;

/** Next.js dynamic-route context for a `[provider]` segment. */
export interface RailRouteContext {
  params: Promise<{ provider: string }>;
}

/** Adds rail-neutral fields to a successful JSON response body. */
export type RailAnnotator = (provider: string, body: Record<string, unknown>) => Record<string, unknown>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Re-serialises `response` with `annotate` applied; returns it untouched when the body is not a JSON object. */
async function annotateJsonResponse(
  response: Response,
  annotate: (body: Record<string, unknown>) => Record<string, unknown>,
): Promise<Response> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (!isPlainObject(body)) return response;

  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return NextResponse.json(annotate(body), { status: response.status, headers });
}

/**
 * Build a route handler for a `/…/{provider}/…` rail-generic path.
 *
 * - Unknown `provider` → 404 (never falls through to another rail's handler).
 * - Known `provider` → the rail's own handler runs unchanged.
 * - `annotate` (optional) adds rail-neutral fields to a successful JSON body.
 */
export function railAliasRoute(handlers: RailHandlers, annotate?: RailAnnotator) {
  return async (request: NextRequest, context: RailRouteContext): Promise<Response> => {
    const { provider } = await context.params;
    const handler = Object.hasOwn(handlers, provider) ? handlers[provider] : undefined;
    if (!handler) {
      return NextResponse.json(
        { error: `Unknown provider: ${provider}` },
        { status: 404, headers: corsHeaders(request) },
      );
    }

    const response = await handler(request);
    if (!annotate || !response.ok) return response;
    return annotateJsonResponse(response, (body) => annotate(provider, body));
  };
}

/** CORS preflight handler for a rail-generic route (mirrors the Stripe-named routes' `OPTIONS`). */
export function railAliasOptions(request: NextRequest): Response {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

// ── POST /api/charge — rail-generic recipient ────────────────────────────────

/** Provider values the charge recipient may name explicitly. `stripe` is the rail whose `customerId` maps onto `stripeCustomerId`. */
const CHARGE_CUSTOMER_PROVIDERS: ReadonlySet<string> = new Set(['stripe']);

export type NormalizedRecipient =
  | { ok: true; to: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Accept the rail-generic charge recipient — `{ customerId, provider? }` —
 * alongside the original `{ stripeCustomerId }` shape (additive: the original
 * keeps working byte-for-byte; a body with neither new field passes through
 * untouched). `customerId` is mapped onto the field the rail's provider reads.
 */
export function normalizeChargeRecipient(to: Record<string, unknown>): NormalizedRecipient {
  if (!('customerId' in to) && !('provider' in to)) return { ok: true, to };

  const { customerId, provider, ...rest } = to;
  if (provider !== undefined) {
    if (typeof provider !== 'string') return { ok: false, error: 'to.provider must be a string' };
    if (!CHARGE_CUSTOMER_PROVIDERS.has(provider)) {
      return { ok: false, error: `Unsupported recipient provider: ${provider}` };
    }
  }
  if (customerId === undefined) return { ok: true, to: rest };
  if (typeof customerId !== 'string' || customerId === '') {
    return { ok: false, error: 'to.customerId must be a non-empty string' };
  }
  // An explicit legacy field wins — a client sending both gets the legacy behavior.
  return { ok: true, to: { stripeCustomerId: customerId, ...rest } };
}
