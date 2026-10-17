import { NextResponse } from 'next/server';
import { readApiSpec } from '@/src/lib/kernel/api-specs';

export const dynamic = 'force-dynamic';

export function GET() {
  return new NextResponse(readApiSpec('github')?.content ?? '', {
    headers: { 'Content-Type': 'text/yaml' },
  });
}
