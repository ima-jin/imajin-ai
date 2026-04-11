import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { getClient } from '@imajin/db';

const sql = getClient();

export async function GET(request: NextRequest) {
  const authResult = await requireAuth(request);

  if (!authResult || 'error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { identity } = authResult;

  if (!identity.actingAs) {
    return NextResponse.json({ error: 'Forbidden: no acting-as scope' }, { status: 403 });
  }

  // Verify actingAs is a node-scope group DID
  const [nodeRow] = await sql`
    SELECT group_did FROM auth.group_identities
    WHERE group_did = ${identity.actingAs}
    AND scope = 'node'
    LIMIT 1
  `;

  if (!nodeRow) {
    return NextResponse.json({ error: 'Forbidden: not a node scope' }, { status: 403 });
  }

  const nodeDid = identity.actingAs;

  const [profileRow] = await sql`
    SELECT display_name FROM profile.profiles
    WHERE did = ${nodeDid}
    LIMIT 1
  `;

  const nodeName: string = (profileRow?.display_name as string) || 'Node';

  return NextResponse.json({ authorized: true, nodeDid, nodeName });
}
