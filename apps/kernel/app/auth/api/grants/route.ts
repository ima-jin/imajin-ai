/**
 * POST /auth/api/grants — issue a scoped delegation grant (#1882).
 * GET  /auth/api/grants — list the authenticated delegator's own grants.
 *
 * Auth: session cookie / bearer only (`requireAuth`). Issuance is user-push
 * only: a caller whose identity carries `X-Acting-For` delegation (i.e. is
 * itself acting as someone's agent) is rejected outright, so authority can
 * never travel through the agent-initiated bootstrap channel — it must
 * originate from the delegator's own directly authenticated session.
 *
 * Body (POST): {
 *   agentDid: string,
 *   capabilities: string[],   // domain:verb, must be in the closed registry
 *   audience: { type: 'all' } | { type: 'dids', values: string[] },
 *   onBehalfOf?: string[],
 *   ttlMs?: number,           // clamped to [default, max] lease bounds
 *   introAttributionTerms?: {
 *     // Consent-at-grant-time (#1886): only meaningful alongside the
 *     // 'intros:propose' capability. Declares the matchmaker's offered
 *     // 70/15/15-style split and attribution window; this IS the
 *     // delegator's consent to those terms, not a separate step.
 *     knockId?: string,       // the #1883 knock this grant followed, if any
 *     split?: { matchmakerBps: number, partyABps: number, partyBBps: number },
 *     attributionWindowDays?: number,
 *   }
 * }
 * Returns: { grant: DelegationGrant, introAttributionTerms?: IntroAttributionTermsRecord }
 */
import { NextResponse } from 'next/server';
import { authErrorResponse, type Identity } from '@imajin/auth';
import { requireGrantPrincipal } from '@/src/lib/auth/grant-principal';
import { issueGrant, listGrantsForDelegator } from '@/src/lib/auth/grants';
import { recordIntroAttributionTerms } from '@/src/lib/fair/intro-attribution';
import { validateIntroAttributionSplitBps, type IntroAttributionSplitBps } from '@imajin/fair';
import { controlsImportOwner } from '@/src/lib/vault/import-authority';
async function mayIssueCloudflareGrant(identity: Identity, delegatorDid: string, capabilities: string[]): Promise<boolean> {
  if (!capabilities.some(capability => capability.startsWith('cloudflare:')) || delegatorDid === identity.id) return true;
  return controlsImportOwner(identity.id, delegatorDid);
}

export async function POST(request: Request) {
  const authResult = await requireGrantPrincipal(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  const { identity } = authResult;

  const delegatorDid = identity.actingAs ?? identity.id;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { agentDid, capabilities, audience, onBehalfOf, ttlMs, introAttributionTerms } = body as {
    agentDid?: string;
    capabilities?: unknown;
    audience?: unknown;
    onBehalfOf?: unknown;
    ttlMs?: unknown;
    introAttributionTerms?: {
      knockId?: string | null;
      split?: IntroAttributionSplitBps;
      attributionWindowDays?: number;
    };
  };

  if (!agentDid || typeof agentDid !== 'string') {
    return NextResponse.json({ error: 'agentDid is required' }, { status: 400 });
  }
  if (!Array.isArray(capabilities) || !capabilities.every((c) => typeof c === 'string')) {
    return NextResponse.json({ error: 'capabilities must be an array of strings' }, { status: 400 });
  }
  if (!(await mayIssueCloudflareGrant(identity, delegatorDid, capabilities))) {
    return authErrorResponse({ error: 'Current zone owner authority required', status: 403 });
  }

  // Validate the intro-attribution split BEFORE issuing the grant (#1886): a
  // malformed offer must never leave a grant behind with no way to declare
  // its terms other than issuing (and consenting to) a brand new one.
  if (introAttributionTerms?.split) {
    const splitCheck = validateIntroAttributionSplitBps(introAttributionTerms.split);
    if (!splitCheck.ok) {
      return NextResponse.json({ error: splitCheck.error }, { status: 400 });
    }
  }

  const result = await issueGrant({
    delegatorDid,
    actorDid: identity.id,
    agentDid,
    capabilities,
    audience,
    onBehalfOf,
    ttlMs: typeof ttlMs === 'number' ? ttlMs : undefined,
  });

  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  if (introAttributionTerms && capabilities.includes('intros:propose')) {
    const termsResult = await recordIntroAttributionTerms({
      grantId: result.grant.grantId,
      delegatorDid,
      knockId: introAttributionTerms.knockId,
      split: introAttributionTerms.split,
      attributionWindowDays: introAttributionTerms.attributionWindowDays,
    });
    if ('error' in termsResult) {
      return NextResponse.json({ error: termsResult.error }, { status: termsResult.status });
    }
    return NextResponse.json({ grant: result.grant, introAttributionTerms: termsResult.terms }, { status: 201 });
  }

  return NextResponse.json({ grant: result.grant }, { status: 201 });
}

export async function GET(request: Request) {
  const authResult = await requireGrantPrincipal(request);
  if ('error' in authResult) {
    return authErrorResponse(authResult);
  }
  const delegatorDid = authResult.identity.actingAs ?? authResult.identity.id;

  const grants = await listGrantsForDelegator(delegatorDid);
  // Record links narrow the existing delegator-only list; an unknown or
  // foreign ID is indistinguishable from an empty result, never a lookup bypass.
  const grantId = new URL(request.url).searchParams.get('grantId');
  return NextResponse.json({ grants: grantId === null ? grants : grants.filter(grant => grant.grantId === grantId) });
}
