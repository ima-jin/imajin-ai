import { NextRequest, NextResponse } from 'next/server';
import { resolveReachRecipient } from '@/src/lib/access/reach-bearer';
import { POST as deliver } from '@/app/auth/api/agents/[did]/reach/route';

export const dynamic = 'force-dynamic';

/** Friendly alias; authentication and delivery remain on the canonical reach surface. */
export async function POST(request: NextRequest, props: Readonly<{ params: Promise<{ handle: string }> }>) {
  try {
    const { handle } = await props.params;
    const recipient = await resolveReachRecipient(handle);
    if (!recipient) return NextResponse.json({ error: 'Reach recipient not found' }, { status: 404 });
    return await deliver(request, { params: Promise.resolve({ did: recipient.id }) });
  } catch {
    // Bearers are never included in logs, including transport/DB failures.
    return NextResponse.json({ error: 'Unable to reach recipient' }, { status: 503 });
  }
}
