import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { controlsImportOwner, isImportHuman } from '@/src/lib/vault/import-authority';
import { resolveVerifiedDomain } from '@/src/lib/domains/service';
import { issueGrant, listGrantsForDelegator } from '@/src/lib/auth/grants';
import { cloudflareZoneDid, isCloudflareImport, isCloudflareZoneId } from '@/src/lib/cloudflare/contract';

export const dynamic = 'force-dynamic';

/** Metadata/action grants only. Credentials still enter exclusively through vault import. */
async function authorizedOwner(request: NextRequest, ownerDid: unknown, domain: unknown, zoneId: unknown) {
  const session = await requireAuth(request);
  if ('error' in session) return null;
  if (session.identity.actingFor || !await isImportHuman(session.identity.id)
    || typeof ownerDid !== 'string' || typeof domain !== 'string' || !isCloudflareZoneId(zoneId)) return null;
  if (!await controlsImportOwner(session.identity.id, ownerDid)) return null;
  const binding = await resolveVerifiedDomain(domain);
  if (binding?.domain !== domain || binding.zoneOwner !== ownerDid) return null;
  return session.identity.id;
}

function response(request: NextRequest, body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { ...corsHeaders(request), 'Cache-Control': 'no-store' } });
}

export async function GET(request: NextRequest) {
  try {
    const query = request.nextUrl.searchParams;
    const ownerDid = query.get('ownerDid');
    const zoneId = query.get('zoneId');
    const actor = await authorizedOwner(request, ownerDid, query.get('domain'), zoneId);
    if (!actor || !ownerDid || !zoneId) return response(request, { error: 'Zone owner authority required' }, 403);
    const grants = (await listGrantsForDelegator(ownerDid)).filter(grant =>
      grant.audience.type === 'dids' && grant.audience.values.includes(cloudflareZoneDid(zoneId))
      && grant.capabilities.some(capability => capability.startsWith('cloudflare:')));
    return response(request, { grants });
  } catch {
    return response(request, { error: 'Zone grant metadata unavailable' }, 503);
  }
}

export async function POST(request: NextRequest) {
  try {
    const raw: unknown = await request.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return response(request, { error: 'Invalid zone grant' }, 400);
    const body = raw as Record<string, unknown>;
    const { ownerDid, domain, zoneId, granteeDid, capabilities, ttlMs } = body;
    if (Object.keys(body).some(key => !['ownerDid', 'domain', 'zoneId', 'granteeDid', 'capabilities', 'ttlMs'].includes(key))
      || !isCloudflareImport({ domain, zoneId, granteeDid, capabilities })
      || (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || Number(ttlMs) <= 0 || Number(ttlMs) > 30 * 86_400_000))) {
      return response(request, { error: 'Invalid zone grant' }, 400);
    }
    const actor = await authorizedOwner(request, ownerDid, domain, zoneId);
    if (!actor) return response(request, { error: 'Zone owner authority required' }, 403);
    const result = await issueGrant({
      delegatorDid: ownerDid as string, actorDid: actor, agentDid: granteeDid as string,
      capabilities: capabilities as string[], audience: { type: 'dids', values: [cloudflareZoneDid(zoneId as string)] },
      ttlMs: ttlMs as number | undefined,
    });
    return 'error' in result ? response(request, { error: 'Zone grant unavailable' }, result.status)
      : response(request, result, 201);
  } catch {
    return response(request, { error: 'Zone grant unavailable' }, 503);
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
