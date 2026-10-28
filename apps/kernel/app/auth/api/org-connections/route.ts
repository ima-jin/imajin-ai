import { NextRequest, NextResponse } from 'next/server';
import { requireDocumentActor } from '@/src/lib/auth/document-authorization';
import { OwnershipError } from '@/src/lib/auth/ownership-policy';
import { changeOrgConnection, listOrgConnections, parseSuspensionInput } from '@/src/lib/kernel/org-connection-admin';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
function failure(error: unknown) {
  if (error instanceof OwnershipError) return NextResponse.json({ error: error.message }, { status: error.status, headers });
  return NextResponse.json({ error: 'Organization connections unavailable' }, { status: 503, headers });
}
export async function GET(request: NextRequest) {
  const actor = await requireDocumentActor(request, { write: true });
  if (actor instanceof Response) return actor;
  try {
    return NextResponse.json(await listOrgConnections(actor), { headers });
  } catch (error) { return failure(error); }
}
export async function POST(request: NextRequest) {
  const actor = await requireDocumentActor(request, { write: true });
  if (actor instanceof Response) return actor;
  let raw: unknown;
  try { raw = await request.json(); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers }); }
  try {
    return NextResponse.json(await changeOrgConnection(actor, parseSuspensionInput(raw)), { headers });
  } catch (error) { return failure(error); }
}
