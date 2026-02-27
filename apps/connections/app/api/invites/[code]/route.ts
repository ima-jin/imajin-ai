import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, invites } from '../../../../src/db/index';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

function corsHeaders(request: NextRequest): Record<string, string> {
  const origin = request.headers.get('origin') || '';
  if (origin.endsWith('.imajin.ai') || origin === 'https://imajin.ai') {
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
  }
  return {};
}

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

async function getSession(request: NextRequest) {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: { Cookie: request.headers.get('cookie') || '' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { code: string } }
) {
  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.code, params.code))
    .limit(1);

  if (!invite) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
  }

  const response = NextResponse.json({
    id: invite.id,
    code: invite.code,
    fromDid: invite.fromDid,
    fromHandle: invite.fromHandle,
    note: invite.note,
    used: invite.usedCount >= invite.maxUses,
    createdAt: invite.createdAt,
  });

  // Allow cross-origin reads from *.imajin.ai (auth needs to validate invites client-side)
  const headers = corsHeaders(_request);
  for (const [key, value] of Object.entries(headers)) {
    response.headers.set(key, value);
  }

  return response;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { code: string } }
) {
  const session = await getSession(request);
  if (!session?.did) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const [invite] = await db
    .select()
    .from(invites)
    .where(eq(invites.code, params.code))
    .limit(1);

  if (!invite) {
    return NextResponse.json({ error: 'Invite not found' }, { status: 404 });
  }

  if (invite.fromDid !== session.did) {
    return NextResponse.json({ error: 'Not authorized' }, { status: 403 });
  }

  await db.delete(invites).where(eq(invites.code, params.code));

  return NextResponse.json({ ok: true });
}
