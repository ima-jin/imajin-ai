import { NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { db } from '@/src/db';
import { resolvePodMembers } from '@imajin/trust-graph';

export async function GET(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const auth = await requireAuth(request);
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const members = await resolvePodMembers(db, params.id);

  return NextResponse.json({ podId: params.id, members: Array.from(members) });
}
