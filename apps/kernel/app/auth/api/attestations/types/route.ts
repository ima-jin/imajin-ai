/**
 * GET /auth/api/attestations/types
 * POST /auth/api/attestations/types
 *
 * Attestation-type registry as DATA, not hardcoded per-service (#1885).
 *
 * GET lists every live registered type (platform-seeded intro-funnel
 * vocabulary plus third-party namespaced types) so callers can discover the
 * vocabulary without reading source.
 *
 * POST registers a new type under the caller's own namespace (their
 * `identities.handle`), gated on `requireEstablishedDID` — trust-tier gating
 * per the Day-1 review. Registering does not touch the compile-time
 * ATTESTATION_TYPES array; both routes are additive extension surfaces
 * consulted by `POST /auth/api/attestations` and `.../internal`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders } from '@imajin/config';
import { requireEstablishedDID, resolveActingDid } from '@imajin/auth';
import {
  listRegisteredAttestationTypes,
  registerAttestationType,
  resolveHandleForDid,
} from '@/src/lib/auth/attestation-type-registry';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);
  const entries = await listRegisteredAttestationTypes();
  return NextResponse.json(entries, { headers: cors });
}

/**
 * Body: { localName: string, description?: string }
 * The namespace is always the caller's own handle — never client-supplied —
 * so nobody can register into someone else's namespace or "platform".
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireEstablishedDID(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const registeredByDid = resolveActingDid(authResult.identity);
  const handle = authResult.identity.handle ?? (await resolveHandleForDid(registeredByDid));
  if (!handle) {
    return NextResponse.json(
      { error: 'A handle is required to register a namespaced attestation type' },
      { status: 400, headers: cors },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { localName, description } = body;
  if (!localName || typeof localName !== 'string') {
    return NextResponse.json({ error: 'localName required' }, { status: 400, headers: cors });
  }
  if (description !== undefined && typeof description !== 'string') {
    return NextResponse.json({ error: 'description must be a string' }, { status: 400, headers: cors });
  }

  const result = await registerAttestationType({ registeredByDid, handle, localName, description });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 409, headers: cors });
  }

  return NextResponse.json(result.entry, { status: 201, headers: cors });
}
