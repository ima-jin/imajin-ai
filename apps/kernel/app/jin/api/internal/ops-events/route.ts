import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { parseLivenessEvent } from '@/src/lib/jin/ops-liveness-contract';
import { recordLivenessEvent } from '@/src/lib/jin/ops-liveness';

export async function POST(request: NextRequest) {
  const expected = process.env.AUTH_INTERNAL_API_KEY;
  const supplied = request.headers.get('x-internal-key');
  if (!expected || !supplied || Buffer.byteLength(expected) !== Buffer.byteLength(supplied)
    || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const text = await request.text();
  if (text.length > 4096) return NextResponse.json({ error: 'Event too large' }, { status: 413 });
  let event;
  try { event = parseLivenessEvent(JSON.parse(text)); }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if (!event) return NextResponse.json({ error: 'Invalid liveness event' }, { status: 400 });
  try {
    await recordLivenessEvent(event);
    return NextResponse.json({ ok: true });
  } catch {
    // Probe retains and redelivers the receipt. No raw error may reach logs.
    return NextResponse.json({ error: 'Ops event unavailable' }, { status: 503 });
  }
}
