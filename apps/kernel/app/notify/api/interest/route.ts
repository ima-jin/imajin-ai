import { NextRequest, NextResponse } from 'next/server';
import { corsHeaders, corsOptions } from '@imajin/config';

const REGISTRY_URL = process.env.REGISTRY_URL;

/**
 * Fetch the scope that an attestation type maps to.
 * TODO(#538): Registry /api/interests/:scope and interest catalog implemented by Agent 1.
 *
 * Returns the scope string, or null if no match found.
 */
async function resolveScopeForAttestation(
  attestationType: string,
  webhookSecret: string,
): Promise<string | null> {
  if (!REGISTRY_URL) {
    console.warn('[interest] REGISTRY_URL not set — cannot resolve scope for', attestationType);
    return null;
  }
  try {
    // Fetch full interest catalog and find matching scope
    const res = await fetch(`${REGISTRY_URL}/api/interests`, {
      headers: { 'x-webhook-secret': webhookSecret },
      cache: 'no-store',
    });
    if (!res.ok) {
      console.error(`[interest] Registry interests fetch failed: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const interests: { scope: string; triggers: string[] }[] = data.interests ?? [];
    const match = interests.find((i) => i.triggers?.includes(attestationType));
    return match?.scope ?? null;
  } catch (err) {
    console.error('[interest] Scope resolution error:', err);
    return null;
  }
}

/**
 * Check whether a did_interests row already exists for DID + scope.
 * TODO(#538): Registry /api/preferences/:did implemented by Agent 1.
 */
async function didInterestExists(
  did: string,
  scope: string,
  webhookSecret: string,
): Promise<boolean> {
  if (!REGISTRY_URL) return false;
  try {
    const res = await fetch(
      `${REGISTRY_URL}/api/preferences/${encodeURIComponent(did)}`,
      { headers: { 'x-webhook-secret': webhookSecret }, cache: 'no-store' },
    );
    if (!res.ok) return false;
    const prefs = await res.json();
    const interests: { scope: string }[] = prefs.interests ?? [];
    return interests.some((i) => i.scope === scope);
  } catch {
    return false;
  }
}

/**
 * Create a did_interests row via registry internal API.
 * Channels enabled/disabled based on DID's auto_subscribe preference.
 * TODO(#538): Registry POST /api/preferences/:did/interests/:scope implemented by Agent 1.
 */
async function createDidInterest(
  did: string,
  scope: string,
  attestationType: string,
  webhookSecret: string,
): Promise<void> {
  if (!REGISTRY_URL) {
    console.warn('[interest] REGISTRY_URL not set — cannot create did_interest');
    return;
  }
  try {
    const res = await fetch(
      `${REGISTRY_URL}/api/preferences/${encodeURIComponent(did)}/interests/${encodeURIComponent(scope)}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-webhook-secret': webhookSecret,
        },
        body: JSON.stringify({ createdByAttestation: attestationType }),
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[interest] Registry create did_interest failed: ${res.status} ${text}`);
    }
  } catch (err) {
    console.error('[interest] Create did_interest error:', err);
  }
}

export async function OPTIONS(request: NextRequest) {
  return corsOptions(request);
}

/**
 * POST /api/interest
 *
 * Records an interest signal for a DID based on an attestation type.
 * Called internally whenever a user performs an action that maps to an interest scope.
 *
 * Body: { did: string, attestationType: string }
 * Auth: x-webhook-secret header
 *
 * Flow:
 *   1. Look up which scope the attestationType maps to in the registry interest catalog
 *   2. Check if did_interests row already exists — if so, no-op
 *   3. If not: POST to registry to create did_interests row
 *      (registry checks auto_subscribe preference to set channel defaults)
 */
export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const secret = request.headers.get('x-webhook-secret');
  if (!secret || secret !== process.env.NOTIFY_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: cors });
  }

  let body: { did: string; attestationType: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const { did, attestationType } = body;
  if (!did || !attestationType) {
    return NextResponse.json(
      { error: 'Missing required fields: did, attestationType' },
      { status: 400, headers: cors },
    );
  }

  // Step 1: Resolve scope
  const scope = await resolveScopeForAttestation(attestationType, secret);
  if (!scope) {
    // Unknown attestation type — not an error, just nothing to record
    return NextResponse.json({ ok: true, action: 'no_scope' }, { headers: cors });
  }

  // Step 2: Check if already exists
  const exists = await didInterestExists(did, scope, secret);
  if (exists) {
    return NextResponse.json({ ok: true, action: 'already_exists' }, { headers: cors });
  }

  // Step 3: Create did_interests row via registry
  await createDidInterest(did, scope, attestationType, secret);

  return NextResponse.json({ ok: true, action: 'created', scope }, { headers: cors });
}
