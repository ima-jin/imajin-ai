import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { db } from '@/db';
import { resolvePodMembers } from '@imajin/trust-graph';

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const members = await resolvePodMembers(db, params.id);

  return NextResponse.json({ podId: params.id, members: Array.from(members) });
}
