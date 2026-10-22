import { NextResponse } from 'next/server';
import { readApiSpec } from '@/src/lib/kernel/api-specs';

export const dynamic = 'force-dynamic';

export function GET() {
  const spec = readApiSpec('infer');
  return new NextResponse(spec?.content ?? '', {
    status: spec ? 200 : 404,
    headers: { 'Content-Type': 'text/yaml' },
  });
}
