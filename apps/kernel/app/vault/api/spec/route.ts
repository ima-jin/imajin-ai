import { NextResponse } from 'next/server';
import { readApiSpec } from '@/src/lib/kernel/api-specs';

export const dynamic = 'force-dynamic';

/** The public endpoint advertised by the canonical spec catalogue. */
export function GET() {
  const spec = readApiSpec('vault');
  return spec
    ? new Response(spec.content, { headers: { 'Content-Type': spec.contentType } })
    : NextResponse.json({ error: 'Vault spec unavailable' }, { status: 503 });
}
