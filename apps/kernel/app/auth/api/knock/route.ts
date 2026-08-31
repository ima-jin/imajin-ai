/**
 * POST /auth/api/knock — external-agent knock submission (#1883).
 *
 * Public, unauthenticated: the knocking agent has no identity yet — that is
 * the entire point ("knock, not registration"). `declared_target` replaces
 * an invite code as the anchor; if it doesn't resolve to an existing
 * principal, the knock is rejected outright (no stub-minting).
 *
 * Carries zero authority: `requested_capabilities` are an advisory preview
 * only, never auto-granted. See apps/kernel/src/lib/auth/knock.ts for the
 * full lifecycle and apps/kernel/app/auth/api/grants/route.ts (#1882) for
 * the only path to actual authority.
 *
 * Basic abuse guarding only (full abuse mechanics are out of scope):
 *   - a coarse per-IP rate limit, and
 *   - a per-target rate limit (#1883 Day-1 review: "rate limiting keys
 *     naturally per-target ... spam worst-case is expired requests, never
 *     identities and never authority").
 *
 * Body: {
 *   publicKey: string,               // 64-char hex Ed25519 public key
 *   declared_target: string,         // DID or handle of an existing principal
 *   self_description: string,
 *   requested_capabilities: string[], // advisory only
 *   external_did?: string,           // optional bring-your-own DID (recorded as an attestation on accept)
 * }
 * (camelCase aliases — declaredTarget / selfDescription / requestedCapabilities /
 * externalDid — are also accepted, matching this codebase's usual JSON convention.)
 */
import { NextRequest, NextResponse } from 'next/server';
import { rateLimit, getClientIP } from '@imajin/config';
import { KNOCK_IP_RATE_LIMIT, KNOCK_IP_RATE_WINDOW, KNOCK_TARGET_RATE_LIMIT, KNOCK_TARGET_RATE_WINDOW } from '@imajin/auth';
import { submitKnock } from '@/src/lib/auth/knock';

export async function POST(request: NextRequest) {
  const ip = getClientIP(request);
  const ipLimit = rateLimit(`knock:ip:${ip}`, KNOCK_IP_RATE_LIMIT, KNOCK_IP_RATE_WINDOW);
  if (ipLimit.limited) {
    return NextResponse.json(
      { error: 'Too many requests', retryAfter: ipLimit.retryAfter },
      { status: 429, headers: { 'Retry-After': String(ipLimit.retryAfter) } },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const declaredTarget = (body.declared_target ?? body.declaredTarget) as unknown;

  if (typeof declaredTarget === 'string' && declaredTarget) {
    const targetLimit = rateLimit(`knock:target:${declaredTarget}`, KNOCK_TARGET_RATE_LIMIT, KNOCK_TARGET_RATE_WINDOW);
    if (targetLimit.limited) {
      return NextResponse.json(
        { error: 'Too many knocks to this target', retryAfter: targetLimit.retryAfter },
        { status: 429, headers: { 'Retry-After': String(targetLimit.retryAfter) } },
      );
    }
  }

  const result = await submitKnock({
    publicKey: body.publicKey,
    declaredTarget,
    selfDescription: body.self_description ?? body.selfDescription,
    requestedCapabilities: body.requested_capabilities ?? body.requestedCapabilities,
    externalDid: body.external_did ?? body.externalDid,
  });

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ knock: result.knock }, { status: 201 });
}
