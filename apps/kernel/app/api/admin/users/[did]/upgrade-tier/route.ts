import { NextRequest, NextResponse } from 'next/server';
import { emitAttestation } from '@imajin/auth';
import { getClient } from '@imajin/db';
import { getNodeDid } from '@/src/lib/kernel/node-identity';
import { requireAdmin } from '@imajin/auth';

const sql = getClient();

const VALID_TIERS = ['preliminary', 'established'] as const;
type Tier = (typeof VALID_TIERS)[number];

const TIER_ATTESTATION_TYPE: Record<Tier, string> = {
  preliminary: 'identity.verified.preliminary',
  established: 'identity.verified.hard',
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ did: string }> }
) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { did } = await params;
  const decodedDid = decodeURIComponent(did);

  let body: { tier?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const tier = body.tier as Tier;
  if (!VALID_TIERS.includes(tier)) {
    return NextResponse.json({ error: 'Invalid tier. Must be preliminary or established.' }, { status: 400 });
  }

  const [identity] = await sql`
    SELECT id, tier FROM auth.identities WHERE id = ${decodedDid} LIMIT 1
  `;
  if (!identity) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  await sql`
    UPDATE auth.identities
    SET tier = ${tier}, updated_at = NOW()
    WHERE id = ${decodedDid}
  `;

  const issuerDid = await getNodeDid();
  if (issuerDid) {
    await emitAttestation({
      issuer_did: issuerDid,
      subject_did: decodedDid,
      type: TIER_ATTESTATION_TYPE[tier],
      context_id: decodedDid,
      context_type: 'identity',
    });
  }

  return NextResponse.json({ ok: true, tier });
}
