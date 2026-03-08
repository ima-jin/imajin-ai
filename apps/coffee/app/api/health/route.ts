import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    service: 'coffee',
    timestamp: new Date().toISOString(),
  });
}
