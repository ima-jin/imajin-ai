import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';
import { ingestSessionCommandFrame } from '@/src/lib/jin/session-command-intake';
import { SessionCommandError } from '@/src/lib/jin/session-command-authority';

export const dynamic = 'force-dynamic';
const input = z.object({ socketDid: z.string().min(1).max(512), frame: z.unknown() }).strict();

function authorized(request: NextRequest): boolean {
  const expected = process.env.AUTH_INTERNAL_API_KEY;
  const provided = request.headers.get('x-internal-key');
  if (!expected || !provided) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  const headers = { 'Cache-Control': 'no-store' };
  if (!authorized(request)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw) > 25 * 1024) return NextResponse.json({ error: 'Frame too large' }, { status: 413, headers });
    const body = input.parse(JSON.parse(raw));
    return NextResponse.json(await ingestSessionCommandFrame(body.socketDid, body.frame), { headers });
  } catch (error) {
    const status = error instanceof SessionCommandError ? error.status
      : error instanceof ZodError || error instanceof SyntaxError ? 400 : 503;
    return NextResponse.json({ error: 'Session event rejected' }, { status, headers });
  }
}
