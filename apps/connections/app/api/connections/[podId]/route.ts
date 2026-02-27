import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/src/db';
import { trustPods, trustPodMembers } from '@imajin/trust-graph';
import { eq, and } from 'drizzle-orm';

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL!;

async function getSessionDid(request: NextRequest): Promise<string | null> {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/imajin_session=([^;]+)/);
  if (!match) return null;

  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/session`, {
      headers: { Cookie: `imajin_session=${match[1]}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.did || data.identity?.did || null;
  } catch {
    return null;
  }
}

/**
 * DELETE /api/connections/:podId - Disconnect from a connection
 * Removes the authenticated user from the pod.
 * If the pod has no members left, deletes the pod.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ podId: string }> }
) {
  const did = await getSessionDid(request);
  if (!did) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { podId } = await params;

  // Verify user is a member of this pod
  const membership = await db.query.trustPodMembers.findFirst({
    where: and(
      eq(trustPodMembers.podId, podId),
      eq(trustPodMembers.did, did)
    ),
  });

  if (!membership) {
    return NextResponse.json({ error: 'Not a member of this connection' }, { status: 404 });
  }

  // Remove user from pod
  await db.delete(trustPodMembers).where(
    and(
      eq(trustPodMembers.podId, podId),
      eq(trustPodMembers.did, did)
    )
  );

  // Check if pod is now empty — if so, delete it
  const remaining = await db.query.trustPodMembers.findFirst({
    where: eq(trustPodMembers.podId, podId),
  });

  if (!remaining) {
    await db.delete(trustPods).where(eq(trustPods.id, podId));
  }

  return NextResponse.json({ disconnected: true });
}
